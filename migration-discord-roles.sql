ALTER TABLE servers ADD COLUMN staff_role_id TEXT;
ALTER TABLE servers ADD COLUMN discord_member_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE servers ADD COLUMN discord_synced_at TEXT;
