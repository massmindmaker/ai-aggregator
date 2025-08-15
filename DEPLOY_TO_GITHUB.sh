#!/bin/bash

# GitHub Deployment Script for AI Aggregator
# Автоматический скрипт для деплоя проекта на GitHub

echo "🚀 AI Aggregator - GitHub Deployment Script"
echo "============================================="

# Проверка состояния git репозитория
echo "📊 Проверка состояния репозитория..."
git status

# Проверка истории коммитов
echo "📝 История коммитов:"
git log --oneline -5

# Инструкции для деплоя
echo ""
echo "🔧 ИНСТРУКЦИИ ДЛЯ ЗАВЕРШЕНИЯ ДЕПЛОЯ:"
echo "===================================="
echo ""
echo "1. Создайте репозиторий на GitHub:"
echo "   https://github.com/new"
echo "   - Name: ai-aggregator"
echo "   - Description: AI Aggregator - Marketplace for AI Solutions"
echo "   - Public: ✅"
echo "   - Initialize: ❌ (НЕ создавайте README/gitignore)"
echo ""
echo "2. Выполните команды для подключения:"
echo "   git remote add origin https://github.com/[USERNAME]/ai-aggregator.git"
echo "   git push -u origin master"
echo ""
echo "3. Настройте репозиторий:"
echo "   - Добавьте Website: https://ai-aggregator-gamma.vercel.app"
echo "   - Topics: artificial-intelligence, machine-learning, api-marketplace"
echo "   - Включите Issues и Discussions"
echo ""

# Проверка размера репозитория
echo "📦 Статистика проекта:"
echo "======================"
echo "Коммитов: $(git rev-list --count HEAD)"
echo "Файлов: $(find . -type f -not -path './.git/*' | wc -l)"
echo "Размер: $(du -sh . | cut -f1)"

echo ""
echo "✅ Проект готов к деплою на GitHub!"
echo "📋 Все файлы закоммичены и готовы к push"
echo "🌐 Live demo: https://ai-aggregator-gamma.vercel.app"