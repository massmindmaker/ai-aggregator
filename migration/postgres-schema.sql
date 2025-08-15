-- PostgreSQL Schema Migration for AI Aggregator Hub to Vercel Postgres
-- This file contains the complete database schema for API Hub metrics
-- Run this script on your Vercel Postgres database

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- Drop existing tables if they exist (for clean migration)
DROP TABLE IF EXISTS request CASCADE;
DROP TABLE IF EXISTS post CASCADE;
DROP TABLE IF EXISTS person CASCADE;
DROP TABLE IF EXISTS api_metrics CASCADE;
DROP TABLE IF EXISTS api_usage_stats CASCADE;
DROP TABLE IF EXISTS api_performance CASCADE;

-- Create person table (users/developers)
CREATE TABLE person (
    id SERIAL PRIMARY KEY,
    uuid UUID DEFAULT uuid_generate_v4() UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    surname VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT true
);

-- Create post table (API documentation, announcements)
CREATE TABLE post (
    id SERIAL PRIMARY KEY,
    uuid UUID DEFAULT uuid_generate_v4() UNIQUE NOT NULL,
    title VARCHAR(500) NOT NULL,
    content TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    published BOOLEAN DEFAULT false,
    post_type VARCHAR(50) DEFAULT 'general',
    tags TEXT[],
    FOREIGN KEY (user_id) REFERENCES person(id) ON DELETE CASCADE
);

-- Create request table (API request metrics)
CREATE TABLE request (
    id SERIAL PRIMARY KEY,
    uuid UUID DEFAULT uuid_generate_v4() UNIQUE NOT NULL,
    uid VARCHAR(255) NOT NULL,
    date TIMESTAMPTZ DEFAULT NOW(),
    product_sid BIGINT,
    endpoint_sid BIGINT,
    appkey VARCHAR(255) NOT NULL,
    latency INTEGER DEFAULT 0,
    response_status INTEGER NOT NULL,
    response_size INTEGER DEFAULT 0,
    response_type VARCHAR(100),
    request_size BIGINT DEFAULT 0,
    request_type VARCHAR(100),
    ip_address INET,
    user_agent TEXT,
    country VARCHAR(2),
    city VARCHAR(100),
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create api_metrics table (aggregated metrics)
CREATE TABLE api_metrics (
    id SERIAL PRIMARY KEY,
    uuid UUID DEFAULT uuid_generate_v4() UNIQUE NOT NULL,
    api_id BIGINT NOT NULL,
    endpoint_id BIGINT,
    date DATE DEFAULT CURRENT_DATE,
    hour INTEGER, -- 0-23 for hourly metrics
    total_requests INTEGER DEFAULT 0,
    successful_requests INTEGER DEFAULT 0,
    failed_requests INTEGER DEFAULT 0,
    avg_latency DECIMAL(10,2) DEFAULT 0,
    max_latency INTEGER DEFAULT 0,
    min_latency INTEGER DEFAULT 0,
    total_bytes_sent BIGINT DEFAULT 0,
    total_bytes_received BIGINT DEFAULT 0,
    unique_users INTEGER DEFAULT 0,
    error_rate DECIMAL(5,2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(api_id, endpoint_id, date, hour)
);

-- Create api_usage_stats table (usage statistics per API key)
CREATE TABLE api_usage_stats (
    id SERIAL PRIMARY KEY,
    uuid UUID DEFAULT uuid_generate_v4() UNIQUE NOT NULL,
    appkey VARCHAR(255) NOT NULL,
    api_id BIGINT NOT NULL,
    date DATE DEFAULT CURRENT_DATE,
    requests_count INTEGER DEFAULT 0,
    quota_limit INTEGER,
    quota_used INTEGER DEFAULT 0,
    overage_requests INTEGER DEFAULT 0,
    last_request_at TIMESTAMPTZ,
    billing_tier VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(appkey, api_id, date)
);

-- Create api_performance table (performance monitoring)
CREATE TABLE api_performance (
    id SERIAL PRIMARY KEY,
    uuid UUID DEFAULT uuid_generate_v4() UNIQUE NOT NULL,
    api_id BIGINT NOT NULL,
    endpoint_path VARCHAR(500) NOT NULL,
    method VARCHAR(10) NOT NULL,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    response_time_ms INTEGER NOT NULL,
    status_code INTEGER NOT NULL,
    request_size_bytes INTEGER DEFAULT 0,
    response_size_bytes INTEGER DEFAULT 0,
    memory_usage_mb DECIMAL(10,2),
    cpu_usage_percent DECIMAL(5,2),
    error_type VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
-- Person table indexes
CREATE INDEX idx_person_email ON person(email);
CREATE INDEX idx_person_created_at ON person(created_at);
CREATE INDEX idx_person_is_active ON person(is_active);

-- Post table indexes
CREATE INDEX idx_post_user_id ON post(user_id);
CREATE INDEX idx_post_created_at ON post(created_at);
CREATE INDEX idx_post_published ON post(published);
CREATE INDEX idx_post_post_type ON post(post_type);
CREATE INDEX idx_post_tags ON post USING GIN(tags);

-- Request table indexes
CREATE INDEX idx_request_uid ON request(uid);
CREATE INDEX idx_request_date ON request(date);
CREATE INDEX idx_request_product_sid ON request(product_sid);
CREATE INDEX idx_request_endpoint_sid ON request(endpoint_sid);
CREATE INDEX idx_request_appkey ON request(appkey);
CREATE INDEX idx_request_response_status ON request(response_status);
CREATE INDEX idx_request_date_appkey ON request(date, appkey);
CREATE INDEX idx_request_date_product_sid ON request(date, product_sid);
CREATE INDEX idx_request_latency ON request(latency);
CREATE INDEX idx_request_ip_country ON request(ip_address, country);

-- API metrics indexes
CREATE INDEX idx_api_metrics_api_id ON api_metrics(api_id);
CREATE INDEX idx_api_metrics_date ON api_metrics(date);
CREATE INDEX idx_api_metrics_api_date ON api_metrics(api_id, date);
CREATE INDEX idx_api_metrics_endpoint_date ON api_metrics(endpoint_id, date);
CREATE INDEX idx_api_metrics_hour ON api_metrics(hour);

-- API usage stats indexes
CREATE INDEX idx_usage_stats_appkey ON api_usage_stats(appkey);
CREATE INDEX idx_usage_stats_api_id ON api_usage_stats(api_id);
CREATE INDEX idx_usage_stats_date ON api_usage_stats(date);
CREATE INDEX idx_usage_stats_appkey_date ON api_usage_stats(appkey, date);

-- API performance indexes
CREATE INDEX idx_performance_api_id ON api_performance(api_id);
CREATE INDEX idx_performance_timestamp ON api_performance(timestamp);
CREATE INDEX idx_performance_endpoint_path ON api_performance(endpoint_path);
CREATE INDEX idx_performance_status_code ON api_performance(status_code);
CREATE INDEX idx_performance_response_time ON api_performance(response_time_ms);

-- Create views for common queries
-- Daily API metrics view
CREATE OR REPLACE VIEW daily_api_metrics AS
SELECT 
    api_id,
    endpoint_id,
    date,
    SUM(total_requests) as daily_requests,
    SUM(successful_requests) as daily_successful,
    SUM(failed_requests) as daily_failed,
    AVG(avg_latency) as avg_daily_latency,
    MAX(max_latency) as max_daily_latency,
    MIN(min_latency) as min_daily_latency,
    SUM(total_bytes_sent) as daily_bytes_sent,
    SUM(total_bytes_received) as daily_bytes_received,
    AVG(error_rate) as avg_error_rate
FROM api_metrics
GROUP BY api_id, endpoint_id, date
ORDER BY date DESC;

-- Top APIs by usage view
CREATE OR REPLACE VIEW top_apis_by_usage AS
SELECT 
    api_id,
    SUM(requests_count) as total_requests,
    COUNT(DISTINCT appkey) as unique_users,
    AVG(quota_used::DECIMAL / NULLIF(quota_limit, 0) * 100) as avg_quota_usage
FROM api_usage_stats
WHERE date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY api_id
ORDER BY total_requests DESC;

-- Error analysis view
CREATE OR REPLACE VIEW error_analysis AS
SELECT 
    date_trunc('hour', date) as hour,
    response_status,
    COUNT(*) as error_count,
    AVG(latency) as avg_latency,
    COUNT(DISTINCT appkey) as affected_users
FROM request
WHERE response_status >= 400
    AND date >= NOW() - INTERVAL '7 days'
GROUP BY date_trunc('hour', date), response_status
ORDER BY hour DESC, error_count DESC;

-- Performance trends view
CREATE OR REPLACE VIEW performance_trends AS
SELECT 
    api_id,
    endpoint_path,
    date_trunc('hour', timestamp) as hour,
    COUNT(*) as request_count,
    AVG(response_time_ms) as avg_response_time,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms) as p95_response_time,
    COUNT(*) FILTER (WHERE status_code >= 500) as server_errors,
    COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) as client_errors
FROM api_performance
WHERE timestamp >= NOW() - INTERVAL '24 hours'
GROUP BY api_id, endpoint_path, date_trunc('hour', timestamp)
ORDER BY hour DESC;

-- Create functions for data aggregation
-- Function to aggregate hourly metrics
CREATE OR REPLACE FUNCTION aggregate_hourly_metrics()
RETURNS void AS $$
BEGIN
    INSERT INTO api_metrics (
        api_id, endpoint_id, date, hour, total_requests, successful_requests,
        failed_requests, avg_latency, max_latency, min_latency,
        total_bytes_sent, total_bytes_received, unique_users, error_rate
    )
    SELECT 
        product_sid as api_id,
        endpoint_sid as endpoint_id,
        date_trunc('day', date)::date,
        EXTRACT(hour FROM date)::integer,
        COUNT(*) as total_requests,
        COUNT(*) FILTER (WHERE response_status < 400) as successful_requests,
        COUNT(*) FILTER (WHERE response_status >= 400) as failed_requests,
        AVG(latency) as avg_latency,
        MAX(latency) as max_latency,
        MIN(latency) as min_latency,
        SUM(request_size) as total_bytes_sent,
        SUM(response_size) as total_bytes_received,
        COUNT(DISTINCT appkey) as unique_users,
        (COUNT(*) FILTER (WHERE response_status >= 400)::decimal / COUNT(*) * 100) as error_rate
    FROM request
    WHERE date >= date_trunc('hour', NOW() - INTERVAL '1 hour')
        AND date < date_trunc('hour', NOW())
        AND product_sid IS NOT NULL
    GROUP BY product_sid, endpoint_sid, date_trunc('day', date), EXTRACT(hour FROM date)
    ON CONFLICT (api_id, endpoint_id, date, hour) DO UPDATE SET
        total_requests = EXCLUDED.total_requests,
        successful_requests = EXCLUDED.successful_requests,
        failed_requests = EXCLUDED.failed_requests,
        avg_latency = EXCLUDED.avg_latency,
        max_latency = EXCLUDED.max_latency,
        min_latency = EXCLUDED.min_latency,
        total_bytes_sent = EXCLUDED.total_bytes_sent,
        total_bytes_received = EXCLUDED.total_bytes_received,
        unique_users = EXCLUDED.unique_users,
        error_rate = EXCLUDED.error_rate,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Function to update usage statistics
CREATE OR REPLACE FUNCTION update_usage_stats()
RETURNS void AS $$
BEGIN
    INSERT INTO api_usage_stats (
        appkey, api_id, date, requests_count, quota_used, last_request_at
    )
    SELECT 
        appkey,
        product_sid as api_id,
        date_trunc('day', date)::date,
        COUNT(*) as requests_count,
        COUNT(*) as quota_used,
        MAX(date) as last_request_at
    FROM request
    WHERE date >= CURRENT_DATE
        AND product_sid IS NOT NULL
    GROUP BY appkey, product_sid, date_trunc('day', date)
    ON CONFLICT (appkey, api_id, date) DO UPDATE SET
        requests_count = EXCLUDED.requests_count,
        quota_used = EXCLUDED.quota_used,
        last_request_at = EXCLUDED.last_request_at,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Create triggers for automatic timestamp updates
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_person_updated_at BEFORE UPDATE ON person
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_post_updated_at BEFORE UPDATE ON post
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_api_metrics_updated_at BEFORE UPDATE ON api_metrics
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_usage_stats_updated_at BEFORE UPDATE ON api_usage_stats
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert default data
INSERT INTO person (name, surname, email) VALUES 
('System', 'Administrator', 'admin@aiag.com'),
('API', 'Monitor', 'monitor@aiag.com')
ON CONFLICT (email) DO NOTHING;

-- Create indexes for optimal Vercel Postgres performance
-- Partial indexes for active records
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_person_active_email 
    ON person(email) WHERE is_active = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_published_date 
    ON post(created_at) WHERE published = true;

-- Composite indexes for common query patterns
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_request_composite_metrics 
    ON request(product_sid, date, response_status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_request_performance_tracking 
    ON request(endpoint_sid, date, latency) 
    WHERE response_status < 400;

-- Comments for documentation
COMMENT ON TABLE person IS 'Users and developers using the API platform';
COMMENT ON TABLE post IS 'API documentation, announcements, and user posts';
COMMENT ON TABLE request IS 'Individual API request logs with detailed metrics';
COMMENT ON TABLE api_metrics IS 'Aggregated hourly metrics per API and endpoint';
COMMENT ON TABLE api_usage_stats IS 'Daily usage statistics per API key';
COMMENT ON TABLE api_performance IS 'Detailed performance monitoring data';

COMMENT ON VIEW daily_api_metrics IS 'Daily aggregated metrics for APIs';
COMMENT ON VIEW top_apis_by_usage IS 'Top APIs ranked by usage in the last 30 days';
COMMENT ON VIEW error_analysis IS 'Error analysis for the last 7 days';
COMMENT ON VIEW performance_trends IS 'Hourly performance trends for the last 24 hours';

-- Grant permissions (adjust as needed for your user)
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO your_vercel_user;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO your_vercel_user;
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO your_vercel_user;

-- Enable row level security (optional, configure as needed)
-- ALTER TABLE person ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE post ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE request ENABLE ROW LEVEL SECURITY;

COMMIT;