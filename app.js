import ExcelJS from 'exceljs';
import mysql from 'mysql2/promise';
import * as fs from "node:fs";
import {ConfigService} from "./config.service.js";


const config = ConfigService.getInstance()

// Сначала объявляем функцию экранирования, чтобы её можно было безопасно вызвать выше
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


function escapeLike(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
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
function appendToCsv(productId, languageId, oldUrl, newUrl, positionInExcel) {
    const escapeCsv = (text) => `"${String(text).replace(/"/g, '""')}"`;
    const row = `${escapeCsv(productId)},${escapeCsv(languageId)},${escapeCsv(oldUrl)},${escapeCsv(newUrl)},${escapeCsv(positionInExcel)}\n`;
    fs.appendFileSync(config.logFilePath, row, 'utf8');
}


const SQL_BATCH_SIZE = 200;

// Читаем результаты порциями, не загружая всю выборку в память.
async function* findDescriptionsByUrl(pool, searchPattern) {
    let lastProductId = 0;
    let lastLanguageId = 0;

    while (true) {
        const [rows] = await pool.execute(
            `
            SELECT product_id, language_id, description
            FROM oc_product_description
            WHERE description LIKE ?
              AND (
                  product_id > ?
                  OR (
                      product_id = ?
                      AND language_id > ?
                  )
              )
            ORDER BY product_id, language_id
            LIMIT ?
            `,
            [
                searchPattern,
                lastProductId,
                lastProductId,
                lastLanguageId,
                SQL_BATCH_SIZE,
            ],
        );

        if (rows.length === 0) {
            break;
        }

        for (const item of rows) {
            lastProductId = Number(item.product_id);
            lastLanguageId = Number(item.language_id);

            yield item;
        }

        if (rows.length < SQL_BATCH_SIZE) {
            break;
        }
    }
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
                fs.writeFileSync(config.logFilePath, 'product_id,language_id,old_url,new_url,position_in_excel\n', 'utf8');
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
                        const searchPattern = `%${escapeLike(cleanUrl)}%`;


                        for await (const item of findDescriptionsByUrl(pool, searchPattern)) {
                            const oldDescription = item.description;

                            // Создаем регулярное выражение для поиска конкретного URL внутри href="..." или href=&quot;...&quot;
                            const escapedUrl = escapeRegExp(cleanUrl)
                                .replace(/\\\/$/, '');

                            // Шаблон ищет совпадение ссылки целиком, предотвращая частичную склейку подкатегорий
                            const hrefRegex = new RegExp(
                                `(href\\s*=\\s*(?:"|'|&quot;|\\\\\\"))` +
                                `(https?:\\/\\/(?:www\\.)?${domainStr}\\.${globalDomainStr})?` +
                                `(${escapedUrl}\\/?)(?=\\s*["'&]|&quot;|\\\\")`,
                                'gi',
                            );

                            const newDescription = oldDescription.replace(
                                hrefRegex,
                                (match, prefix, currentDomain = '') =>
                                    `${prefix}${currentDomain}${cleanTarget}`,
                            );

                            if (oldDescription !== newDescription) {
                                if (config.dryRun != 'true') {
                                    await pool.query(
                                        'UPDATE oc_product_description SET description = ? WHERE product_id = ? AND language_id = ?',
                                        [newDescription, item.product_id, item.language_id]
                                    );
                                } else {
                                    // Пока только режим проверки: БД не изменяем.
                                    console.log(
                                        `Найдена замена: product_id=${item.product_id}, ` +
                                        `language_id=${item.language_id}: ${url} -> ${target}`,
                                    );
                                }


                                if (config.logFilePath) {
                                    appendToCsv(
                                        item.product_id,
                                        item.language_id,
                                        url,
                                        target,
                                        row.number
                                    );
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
