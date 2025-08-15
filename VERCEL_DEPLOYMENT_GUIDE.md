# AI Aggregator - Vercel Deployment Guide

Этот гид поможет развернуть AI Aggregator проект на Vercel с учетом специфической архитектуры проекта.

## Структура проекта

```
aiag/
├── aiag_back/          # Основное приложение (React + Node.js)
│   ├── react-ui/       # React frontend
│   ├── server/         # Express.js backend
│   ├── routes/         # API routes
│   ├── vercel.json     # Конфигурация Vercel
│   └── vercel-server.js # Адаптер для Vercel
└── aiaghub/           # Отдельный API Hub сервис
    ├── server/         # Express.js backend
    ├── routes/         # API routes
    ├── vercel.json     # Конфигурация Vercel
    └── vercel-server.js # Адаптер для Vercel
```

## Предварительные требования

1. Аккаунт Vercel
2. Vercel CLI: `npm install -g vercel`
3. MongoDB Atlas или другая облачная база данных
4. Настроенные переменные окружения

## Настройка переменных окружения

### Для основного проекта (aiag_back)

В панели Vercel добавьте следующие переменные окружения:

```bash
# Database
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/database
mongoUri=mongodb+srv://username:password@cluster.mongodb.net/database

# JWT
JWT_SECRET=ваш-секретный-ключ-jwt

# Email
EMAIL_USER=ваш-email@example.com
EMAIL_PASS=пароль-от-email

# Yandex Cloud
YANDEX_CLOUD_HOST=https://aiagweb.storage.yandexcloud.net

# Payment
YOOKASSA_SHOP_ID=id-магазина-юkassa
YOOKASSA_SECRET_KEY=секретный-ключ-юkassa

# Environment
NODE_ENV=production
```

### Для API Hub (aiaghub)

```bash
# Database
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/database
mongoUri=mongodb+srv://username:password@cluster.mongodb.net/database

# PostgreSQL (если используется)
PG_HOST=хост-postgres
PG_USER=пользователь-postgres
PG_PASSWORD=пароль-postgres
PG_DATABASE=база-данных-postgres
PG_PORT=5432

# JWT
JWT_SECRET=ваш-секретный-ключ-jwt

# Environment
NODE_ENV=production
```

## Шаги деплоя

### 1. Подготовка проектов

#### Основной проект (aiag_back):
```bash
cd aiag_back
npm install
cd react-ui
npm install
npm run build
cd ..
```

#### API Hub (aiaghub):
```bash
cd aiaghub
npm install
```

### 2. Деплой основного проекта

```bash
cd aiag_back
vercel
```

При первом деплое Vercel спросит:
- Set up and deploy "~/aiag/aiag_back"? `Y`
- Which scope? Выберите свой аккаунт
- What's your project's name? `ai-aggregator`
- In which directory is your code located? `./`

### 3. Деплой API Hub

```bash
cd ../aiaghub
vercel
```

При деплое:
- Set up and deploy "~/aiag/aiaghub"? `Y`
- Which scope? Выберите свой аккаунт
- What's your project's name? `aiag-hub`
- In which directory is your code located? `./`

### 4. Настройка доменов

После успешного деплоя:

1. Основной проект будет доступен по адресу: `https://ai-aggregator.vercel.app`
2. API Hub будет доступен по адресу: `https://aiag-hub.vercel.app`

При необходимости можно настроить кастомные домены в панели Vercel.

## Особенности конфигурации

### React Build Configuration

Конфигурация учитывает, что React приложение находится в подпапке `react-ui/`:

```json
{
  "src": "react-ui/package.json",
  "use": "@vercel/static-build",
  "config": {
    "distDir": "build",
    "buildCommand": "npm run build"
  }
}
```

### API Routes

Все API маршруты настроены для корректной работы с Vercel Functions:

- `/api/*` - основные API endpoints
- `/auth/*` - аутентификация
- `/user/*` - пользователи
- `/market/*` - маркетплейс
- И другие согласно структуре routes/

### Database Connection

Используется connection pooling для оптимизации работы с базой данных в serverless среде:

```javascript
let cachedDb = null

async function connectDatabase() {
  if (cachedDb) {
    return cachedDb
  }
  // ... connection logic
}
```

## Мониторинг и отладка

### Просмотр логов

```bash
vercel logs ai-aggregator
vercel logs aiag-hub
```

### Проверка функций

```bash
vercel functions ls
```

### Локальная разработка с Vercel

```bash
vercel dev
```

## Решение проблем

### Проблема 1: Ошибки сборки React

Убедитесь, что:
- В `react-ui/package.json` есть правильный build script
- Все зависимости установлены
- NODE_OPTIONS установлен для legacy OpenSSL

### Проблема 2: 502 Bad Gateway

Проверьте:
- Переменные окружения установлены правильно
- База данных доступна
- Нет синтаксических ошибок в коде

### Проблема 3: Статические файлы не загружаются

Проверьте routing в vercel.json:
```json
{
  "src": "/(.*\\.(png|jpg|jpeg|gif|svg|ico|webp|pdf))",
  "dest": "/react-ui/build/$1"
}
```

## Обновление проекта

```bash
# Для основного проекта
cd aiag_back
vercel --prod

# Для API Hub
cd ../aiaghub
vercel --prod
```

## Бэкап и безопасность

1. Регулярно создавайте бэкапы базы данных
2. Используйте секретные переменные окружения для чувствительных данных
3. Настройте CORS правильно для production
4. Используйте HTTPS для всех соединений

## Полезные команды

```bash
# Просмотр deployments
vercel ls

# Удаление deployment
vercel remove [deployment-url]

# Просмотр информации о проекте
vercel project ls

# Настройка алиасов
vercel alias set [deployment-url] [custom-domain]
```

## Поддержка

При возникновении проблем:
1. Проверьте логи Vercel
2. Убедитесь в правильности переменных окружения
3. Проверьте соединение с базой данных
4. Убедитесь в корректности API endpoints

Этот гид покрывает основные аспекты деплоя AI Aggregator на Vercel с учетом специфической архитектуры проекта.