ALTER TABLE servers ADD COLUMN current_activity TEXT NOT NULL DEFAULT '';
ALTER TABLE servers ADD COLUMN server_type TEXT NOT NULL DEFAULT 'normal';
