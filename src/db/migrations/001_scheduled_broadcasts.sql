-- v4.1 additions: scheduled broadcasts
-- A scheduled broadcast stores the message + audience; a scheduler sweep in
-- server.ts dispatches due ones and writes the same notifications a manual
-- send would, so the audit trail is identical.

CREATE SEQUENCE IF NOT EXISTS broadcast_id_seq START 1;

CREATE TABLE IF NOT EXISTS scheduled_broadcasts (
    id VARCHAR PRIMARY KEY DEFAULT pad_id('BCT-', nextval('broadcast_id_seq')),
    sender_id VARCHAR REFERENCES users(id) NOT NULL,
    message TEXT NOT NULL,
    defaulters_only BOOLEAN DEFAULT false,
    scheduled_for TIMESTAMP,
    sent_at TIMESTAMP,
    status VARCHAR NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'cancelled')),
    recipient_count INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_sender ON scheduled_broadcasts(sender_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_due ON scheduled_broadcasts(status, scheduled_for);
