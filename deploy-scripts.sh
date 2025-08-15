#!/bin/bash

# AI Aggregator - Vercel Deployment Scripts
# Скрипты для быстрого деплоя проектов на Vercel

echo "AI Aggregator - Vercel Deployment Scripts"
echo "========================================"

# Функция для деплоя основного проекта
deploy_main() {
    echo "Deploying main project (aiag_back)..."
    cd aiag_back
    
    echo "Installing dependencies..."
    npm install
    
    echo "Building React app..."
    cd react-ui
    npm install
    npm run vercel-build
    cd ..
    
    echo "Deploying to Vercel..."
    vercel --prod
    
    echo "Main project deployed successfully!"
    cd ..
}

# Функция для деплоя API Hub
deploy_hub() {
    echo "Deploying API Hub (aiaghub)..."
    cd aiaghub
    
    echo "Installing dependencies..."
    npm install
    
    echo "Deploying to Vercel..."
    vercel --prod
    
    echo "API Hub deployed successfully!"
    cd ..
}

# Функция для деплоя обоих проектов
deploy_all() {
    echo "Deploying all projects..."
    deploy_main
    deploy_hub
    echo "All projects deployed successfully!"
}

# Функция для проверки статуса
check_status() {
    echo "Checking deployment status..."
    echo "Main project deployments:"
    cd aiag_back && vercel ls && cd ..
    echo "API Hub deployments:"
    cd aiaghub && vercel ls && cd ..
}

# Функция для просмотра логов
view_logs() {
    echo "Select project to view logs:"
    echo "1) Main project (ai-aggregator)"
    echo "2) API Hub (aiag-hub)"
    read -p "Enter choice (1-2): " choice
    
    case $choice in
        1)
            vercel logs ai-aggregator
            ;;
        2)
            vercel logs aiag-hub
            ;;
        *)
            echo "Invalid choice"
            ;;
    esac
}

# Главное меню
show_menu() {
    echo ""
    echo "Select deployment option:"
    echo "1) Deploy main project only"
    echo "2) Deploy API Hub only"
    echo "3) Deploy all projects"
    echo "4) Check deployment status"
    echo "5) View logs"
    echo "6) Exit"
    echo ""
}

# Основной цикл
while true; do
    show_menu
    read -p "Enter your choice (1-6): " choice
    
    case $choice in
        1)
            deploy_main
            ;;
        2)
            deploy_hub
            ;;
        3)
            deploy_all
            ;;
        4)
            check_status
            ;;
        5)
            view_logs
            ;;
        6)
            echo "Goodbye!"
            exit 0
            ;;
        *)
            echo "Invalid choice. Please try again."
            ;;
    esac
done