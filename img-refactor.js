import mysql from 'mysql2/promise';
import { JSDOM } from 'jsdom';
import he from 'he';
import {ConfigService} from "./config.service.js";

const config = ConfigService.getInstance()
// Конфигурация пула подключений
const dbConfig = {
    host: config.host,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
}

// Создаем пул соединений
const pool = mysql.createPool(dbConfig);
console.log('Пул подключений к MySQL успешно инициализирован.');

// Настройки пагинации
const BATCH_SIZE = 500;

async function main() {
    try {
        let offset = 0;
        let hasMore = true;
        let totalUpdated = 0;

        while (hasMore) {
            console.log(`Получение записей с ${offset} по ${offset + BATCH_SIZE}...`);

            // Запрос выполняется автоматически через свободное соединение из пула
            const [rows] = await pool.query(
                `SELECT product_id, language_id, name, description FROM oc_product_description LIMIT ? OFFSET ? `,
                [BATCH_SIZE, offset]
            );

            if (rows.length === 0) {
                hasMore = false;
                break;
            }

            for (const row of rows) {
                const { product_id, language_id, name, description } = row;

                if (!description || !description.includes('&lt;img')) {
                    continue;
                }

                // Декодируем HTML-сущности в реальный HTML
                const decodedDescription = he.decode(description);

                const dom = new JSDOM(`<body>${decodedDescription}</body>`);
                const document = dom.window.document;
                const images = document.querySelectorAll('img');

                if (images.length === 0) {
                    continue;
                }

                images.forEach((img, index) => {
                    const photoNumber = index + 1;
                    const newValue = `${name} ${photoNumber} фото`;

                    img.setAttribute('alt', newValue);
                    img.setAttribute('title', newValue);
                });

                const modifiedHtml = document.body.innerHTML;

                // Кодируем обратно в HTML-сущности (сохраняя кириллицу)
                const encodedDescription =  modifiedHtml
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');

                if (encodedDescription !== description) {
                    await pool.query(
                        `UPDATE oc_product_description SET description = ? WHERE product_id = ? AND language_id = ?`,
                        [encodedDescription, product_id, language_id]
                    );
                    totalUpdated++;
                }
            }

            offset += BATCH_SIZE;
        }

        console.log(`Обработка успешно завершена! Всего обновлено записей: ${totalUpdated}`);

    } catch (error) {
        console.error('Произошла ошибка в процессе выполнения:', error);
    } finally {
        // Обязательно закрываем пул, чтобы Node.js завершил процесс, а не «завис» в ожидании
        await pool.end();
        console.log('Пул подключений к базе данных закрыт.');
        //process.exit(0);
    }
}

main();
