import { config } from "dotenv";

/**
 * Индексер: позволяет обращаться к полям как к свойствам объекта
 * key: имя ключа (строка), value: значение ключа (строка)
 */
export class ConfigService {
    static instance = null;

    constructor() {
        if (ConfigService.instance) {
            return ConfigService.instance;
        }

        const { error, parsed } = config();

        if (error) {
            throw new Error("Не найден файл .env");
        }

        if (!parsed) {
            throw new Error("Пустой файл .env");
        }

        this.config = parsed;

        // Генерируем динамический объект с преобразованием имен
        Object.keys(this.config).forEach((key) => {
            // Преобразуем "EXCEL_FILE_PATH" -> "excelFilePath"
            const camelCaseKey = key
                .toLowerCase()
                .replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

            Object.defineProperty(this, camelCaseKey, {
                get: () => this.config[key],
                enumerable: true,
            });
        });

        ConfigService.instance = this;
        return this;
    }

    /**
     * Метод для получения значения по ключу (для обратной совместимости)
     */
    get(key) {
        const res = this.config[key];
        if (!res) {
            throw new Error(`Нет такого ключа: ${key}`);
        }
        return res;
    }

    // Статический метод для получения экземпляра (синглтон)
    static getInstance() {
        if (!ConfigService.instance) {
            ConfigService.instance = new ConfigService();
        }
        return ConfigService.instance;
    }
}
