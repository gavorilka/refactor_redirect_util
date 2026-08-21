import ExcelJS from 'exceljs';
import mysql from 'mysql2/promise';
import * as fs from "node:fs";
import {ConfigService} from "./config.service.js";


const config = ConfigService.getInstance()

// Сначала объявляем функцию экранирования, чтобы её можно было безопасно вызвать выше
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getCleanValue(row, headers, columnName) {
    const colIndex = headers.indexOf(columnName);
    if (colIndex === -1) return null;
    const cell = row.getCell(colIndex);
    if (!cell || cell.value === undefined || cell.value === null) return null;
    if (typeof cell.value === 'object') return cell.value.text || cell.value.result || null;
    return String(cell.value).trim();
}

// Функция для записи строки в CSV (автоматически экранирует кавычки и запятые)
function appendToCsv(productId, languageId, oldUrl, newUrl) {
    const escapeCsv = (text) => `"${String(text).replace(/"/g, '""')}"`;
    const row = `${escapeCsv(productId)},${escapeCsv(languageId)},${escapeCsv(oldUrl)},${escapeCsv(newUrl)}\n`;
    fs.appendFileSync(config.logFilePath, row, 'utf8');
}

async function runSafeMigration() {
    const domainStr = escapeRegExp(config.domain);
    const globalDomainStr = escapeRegExp(config.globalDomain || 'com');
    const allowedHttpCodes = JSON.parse(config.targetHttpCodes).map(Number);
    const startFromRow = (() => {
        try {
            return Number(config.startFromRow) || 2;
        } catch (e) {
            return 2;
        }
    })();

    // --- НАСТРОЙКИ ПОДКЛЮЧЕНИЯ ---
    const dbConfig = {
        host: config.host,
        user: config.user,
        password: config.password,
        database: config.database,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    }

    let pool;
    try {
        pool = mysql.createPool(dbConfig);
        console.log('Соединение с БД успешно установлено.');

        // Создаем CSV файл и записываем заголовки колонок
        // ЧЕНДЖ: Переписана инициализация логов. Если мы начинаем НЕ сначала (startFromRow > 2)
        // и файл уже существует, то МЫ НЕ ЗАТИРАЕМ его, а просто продолжаем писать в конец.
        if (config.logFilePath) {
            const fileExists = fs.existsSync(config.logFilePath);
            if (startFromRow <= 2 || !fileExists) {
                fs.writeFileSync(config.logFilePath, 'product_id,language_id,old_url,new_url\n', 'utf8');
                console.log(`Файл логов инициализирован с нуля: ${config.logFilePath}`);
            } else {
                console.log(`Файл логов уже существует. Продолжаем запись в: ${config.logFilePath}`);
            }
        }

        const workbook = new ExcelJS.stream.xlsx.WorkbookReader(config.get("EXCEL_FILE_PATH"), {});

        let checkedRows = 0;
        let dbUpdatesCount = 0;

        const usingRegExp = new RegExp(`https?:\\/\\/(www\\.)?${domainStr}\\.${globalDomainStr}`, 'i');

        for await (const worksheet of workbook) {
            let headers = [];

            for await (const row of worksheet) {
                // Строку №1 (шапку) обрабатываем ВСЕГДА, чтобы прочитать названия колонок
                if (row.number === 1) {
                    headers = row.values.map(v => typeof v === 'string' ? v.trim() : v);
                    continue;
                }

                // ЧЕНДЖ: Пропускаем строки, если текущий номер меньше заданного начального
                if (row.number < startFromRow) {
                    continue;
                }

                console.log(`Строка: ${row.number}`)

                checkedRows++;

                const httpCode = getCleanValue(row, headers, 'httpCode');
                const url = getCleanValue(row, headers, 'url');
                const target = getCleanValue(row, headers, 'target');

                if (httpCode && allowedHttpCodes.includes(Number(httpCode)) && url && target) {

                    try {
                        // Очищаем протоколы и домены, чтобы корректно сравнивать и абсолютные, и относительные ссылки
                        const cleanUrl = url.replace(usingRegExp, '');
                        const cleanTarget = target.replace(usingRegExp, '');

                        // Если после очистки URL пустой (ссылка на главную), пропускаем во избежание коллизий
                        if (!cleanUrl || cleanUrl === '/') continue;

                        // Чтобы найти все записи, используем базовый поиск по подстроке
                        const searchPattern = `%${cleanUrl}%`;

                        const [rowsToUpdate] = await pool.query(
                            'SELECT product_id, language_id, description FROM oc_product_description WHERE description LIKE ?',
                            [searchPattern]
                        );

                        for (const item of rowsToUpdate) {
                            const oldDescription = item.description;

                            // Создаем регулярное выражение для поиска конкретного URL внутри href="..." или href=&quot;...&quot;
                            const escapedUrl = escapeRegExp(cleanUrl).replace(/\\\/$/, ''); // убираем слэш с конца для универсальности regex

                            // Шаблон ищет совпадение ссылки целиком, предотвращая частичную склейку подкатегорий
                            const hrefRegex = new RegExp(
                                `(href\\s*=\\s*(?:"|'|&quot;|\\\\"))(https?:\\/\\/(?:www\\.)?${domainStr}\\.${globalDomainStr})?(${escapedUrl}\\/?)(?=\\s*["'&]|&quot;|\\\\")`,
                                'g'
                            );

                            // Выполняем замену
                            const newDescription = oldDescription.replace(hrefRegex, (match, p1, p2) => {
                                // p1 — это 'href="', p2 — это домен (если был абсолютным)
                                const currentDomain = p2 || '';
                                return `${p1}${currentDomain}${cleanTarget}`;
                            });

                            // Если замена действительно произошла и строка изменилась
                            if (oldDescription !== newDescription) {
                                await pool.query(
                                    'UPDATE oc_product_description SET description = ? WHERE product_id = ? AND language_id = ?',
                                    [newDescription, item.product_id, item.language_id]
                                );
                                console.log(`Обновление ссылки: ${url}\n На: ${target}`)
                                if (config.logFilePath) {
                                    appendToCsv(item.product_id, item.language_id, url, target);
                                }
                                dbUpdatesCount++;
                            }
                        }
                    } catch (dbError) {
                        console.error(`Ошибка СУБД на строке XLSX №${row.number}:`, dbError.message);
                    }
                }
            }
        }

        console.log(`\n=== ОТЧЕТ О ВЫПОЛНЕНИИ ===`);
        console.log(`Проверено строк из файла: ${checkedRows}`);
        console.log(`Успешно и безопасно заменено ссылок в БД: ${dbUpdatesCount}`);

    } catch (error) {
        console.error('Критический сбой скрипта:', error);
    } finally {
        if (pool) pool.end();
    }
}

runSafeMigration();
