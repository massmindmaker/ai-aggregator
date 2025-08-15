-- AI Aggregator Hub - Vercel Postgres Schema
-- Optimized schema for API Hub metrics and analytics

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- Person table (enhanced from original)
CREATE TABLE person (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    surname VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT true
);

-- Posts table (enhanced from original)
CREATE TABLE post (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    content TEXT,
    user_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    published BOOLEAN DEFAULT false,
    FOREIGN KEY (user_id) REFERENCES person(id) ON DELETE CASCADE
);

-- Enhanced request table with additional metrics
CREATE TABLE request (
    id SERIAL PRIMARY KEY,
    uid VARCHAR(255) NOT NULL,
    date TIMESTAMPTZ DEFAULT NOW(),
    product_sid BIGINT NOT NULL,
    endpoint_sid BIGINT NOT NULL,
    appkey VARCHAR(255) NOT NULL,
    latency INTEGER NOT NULL,
    response_status INTEGER NOT NULL,
    response_size INTEGER DEFAULT 0,
    response_type VARCHAR(100),
    request_size BIGINT DEFAULT 0,
    request_type VARCHAR(100),
    -- Additional analytics fields
    user_agent TEXT,
    ip_address INET,
    country_code VARCHAR(2),
    city VARCHAR(100),
    referrer TEXT,
    -- Performance metrics
    dns_time INTEGER DEFAULT 0,
    connect_time INTEGER DEFAULT 0,
    ssl_time INTEGER DEFAULT 0,
    -- Error tracking
    error_message TEXT,
    error_code VARCHAR(50),
    -- Billing and usage
    credits_used INTEGER DEFAULT 1,
    plan_type VARCHAR(50),
    -- Indexes
    INDEX idx_request_date (date),
    INDEX idx_request_product_sid (product_sid),
    INDEX idx_request_endpoint_sid (endpoint_sid),
    INDEX idx_request_appkey (appkey),
    INDEX idx_request_status (response_status),
    INDEX idx_request_uid_date (uid, date),
    INDEX idx_request_product_endpoint (product_sid, endpoint_sid)
);

-- API Products table
CREATE TABLE api_products (
    id SERIAL PRIMARY KEY,
    sid BIGINT UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    owner_id INTEGER,
    category VARCHAR(100),
    version VARCHAR(50) DEFAULT '1.0.0',
    base_url TEXT,
    documentation_url TEXT,
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    FOREIGN KEY (owner_id) REFERENCES person(id)
);

-- API Endpoints table
CREATE TABLE api_endpoints (
    id SERIAL PRIMARY KEY,
    sid BIGINT UNIQUE NOT NULL,
    product_sid BIGINT NOT NULL,
    path VARCHAR(500) NOT NULL,
    method VARCHAR(10) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    rate_limit INTEGER,
    timeout_ms INTEGER DEFAULT 30000,
    is_public BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    FOREIGN KEY (product_sid) REFERENCES api_products(sid),
    UNIQUE(product_sid, path, method)
);

-- API Keys table
CREATE TABLE api_keys (
    id SERIAL PRIMARY KEY,
    key_value VARCHAR(255) UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    name VARCHAR(255),
    permissions JSONB,
    rate_limit INTEGER,
    expires_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    usage_count INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES person(id)
);

-- Analytics aggregation tables for performance

-- Daily request statistics
CREATE TABLE daily_request_stats (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    product_sid BIGINT NOT NULL,
    endpoint_sid BIGINT,
    total_requests INTEGER DEFAULT 0,
    successful_requests INTEGER DEFAULT 0,
    failed_requests INTEGER DEFAULT 0,
    avg_latency NUMERIC(10,2),
    total_data_transferred BIGINT DEFAULT 0,
    unique_users INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(date, product_sid, endpoint_sid)
);

-- Hourly request statistics for real-time analytics
CREATE TABLE hourly_request_stats (
    id SERIAL PRIMARY KEY,
    hour TIMESTAMPTZ NOT NULL,
    product_sid BIGINT NOT NULL,
    endpoint_sid BIGINT,
    total_requests INTEGER DEFAULT 0,
    successful_requests INTEGER DEFAULT 0,
    failed_requests INTEGER DEFAULT 0,
    avg_latency NUMERIC(10,2),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(hour, product_sid, endpoint_sid)
);

-- User usage statistics
CREATE TABLE user_usage_stats (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    product_sid BIGINT NOT NULL,
    date DATE NOT NULL,
    requests_count INTEGER DEFAULT 0,
    data_transferred BIGINT DEFAULT 0,
    credits_used INTEGER DEFAULT 0,
    avg_latency NUMERIC(10,2),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    FOREIGN KEY (user_id) REFERENCES person(id),
    UNIQUE(user_id, product_sid, date)
);

-- Error tracking table
CREATE TABLE error_logs (
    id SERIAL PRIMARY KEY,
    request_id INTEGER,
    error_type VARCHAR(100) NOT NULL,
    error_message TEXT,
    stack_trace TEXT,
    user_id INTEGER,
    product_sid BIGINT,
    endpoint_sid BIGINT,
    occurred_at TIMESTAMPTZ DEFAULT NOW(),
    resolved BOOLEAN DEFAULT false,
    FOREIGN KEY (request_id) REFERENCES request(id),
    FOREIGN KEY (user_id) REFERENCES person(id)
);

-- Performance optimization indexes
CREATE INDEX idx_request_date_product ON request(date, product_sid);
CREATE INDEX idx_request_date_endpoint ON request(date, endpoint_sid);
CREATE INDEX idx_request_status_date ON request(response_status, date);
CREATE INDEX idx_request_latency ON request(latency) WHERE latency > 1000;
CREATE INDEX idx_api_keys_active ON api_keys(is_active, expires_at);
CREATE INDEX idx_daily_stats_date ON daily_request_stats(date);
CREATE INDEX idx_hourly_stats_hour ON hourly_request_stats(hour);
CREATE INDEX idx_error_logs_occurred ON error_logs(occurred_at);

-- Partitioning for large tables (requests by month)
-- This will be created by the migration script as needed

-- Views for common queries

-- Active API products with statistics
CREATE VIEW v_api_products_stats AS
SELECT 
    p.id,
    p.sid,
    p.name,
    p.description,
    p.category,
    p.status,
    COUNT(DISTINCT e.id) as endpoint_count,
    COUNT(DISTINCT r.uid) as unique_users_today,
    COUNT(r.id) as requests_today,
    AVG(r.latency) as avg_latency_today
FROM api_products p
LEFT JOIN api_endpoints e ON p.sid = e.product_sid
LEFT JOIN request r ON p.sid = r.product_sid AND r.date >= CURRENT_DATE
WHERE p.status = 'active'
GROUP BY p.id, p.sid, p.name, p.description, p.category, p.status;

-- User API usage summary
CREATE VIEW v_user_api_usage AS
SELECT 
    p.id,
    p.name,
    p.email,
    COUNT(DISTINCT r.product_sid) as products_used,
    COUNT(r.id) as total_requests,
    SUM(r.credits_used) as total_credits,
    AVG(r.latency) as avg_latency,
    MAX(r.date) as last_request_date
FROM person p
LEFT JOIN api_keys ak ON p.id = ak.user_id
LEFT JOIN request r ON ak.key_value = r.appkey
GROUP BY p.id, p.name, p.email;

-- Functions for maintenance

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_person_updated_at BEFORE UPDATE ON person
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_post_updated_at BEFORE UPDATE ON post
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_api_products_updated_at BEFORE UPDATE ON api_products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_api_endpoints_updated_at BEFORE UPDATE ON api_endpoints
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to cleanup old data
CREATE OR REPLACE FUNCTION cleanup_old_data()
RETURNS void AS $$
BEGIN
    -- Delete requests older than 1 year
    DELETE FROM request WHERE date < NOW() - INTERVAL '1 year';
    
    -- Delete hourly stats older than 30 days
    DELETE FROM hourly_request_stats WHERE hour < NOW() - INTERVAL '30 days';
    
    -- Delete resolved error logs older than 90 days
    DELETE FROM error_logs WHERE resolved = true AND occurred_at < NOW() - INTERVAL '90 days';
    
    -- Update statistics
    ANALYZE request;
    ANALYZE daily_request_stats;
    ANALYZE hourly_request_stats;
END;
$$ LANGUAGE plpgsql;

-- Stored procedures for analytics

-- Get API usage for a product
CREATE OR REPLACE FUNCTION get_product_usage_stats(
    p_product_sid BIGINT,
    p_start_date DATE DEFAULT CURRENT_DATE - INTERVAL '30 days',
    p_end_date DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE(
    date DATE,
    total_requests INTEGER,
    successful_requests INTEGER,
    failed_requests INTEGER,
    avg_latency NUMERIC,
    unique_users INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        drs.date,
        drs.total_requests,
        drs.successful_requests,
        drs.failed_requests,
        drs.avg_latency,
        drs.unique_users
    FROM daily_request_stats drs
    WHERE drs.product_sid = p_product_sid
    AND drs.date BETWEEN p_start_date AND p_end_date
    ORDER BY drs.date;
END;
$$ LANGUAGE plpgsql;

-- Comments for documentation
COMMENT ON TABLE person IS 'User accounts and profile information';
COMMENT ON TABLE post IS 'User posts and content';
COMMENT ON TABLE request IS 'API request logs with detailed metrics';
COMMENT ON TABLE api_products IS 'Available API products and services';
COMMENT ON TABLE api_endpoints IS 'Individual API endpoints for each product';
COMMENT ON TABLE api_keys IS 'API authentication keys for users';
COMMENT ON TABLE daily_request_stats IS 'Aggregated daily statistics for requests';
COMMENT ON TABLE hourly_request_stats IS 'Aggregated hourly statistics for real-time analytics';
COMMENT ON TABLE user_usage_stats IS 'User-specific usage statistics and billing data';
COMMENT ON TABLE error_logs IS 'Error tracking and debugging information';