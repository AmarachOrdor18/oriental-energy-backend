-- v4.2: admin-controlled page access (role-based access control, admin override)
-- Pages a user can reach are resolved as: their role's defaults, overridden by
-- explicit per-user grants (allow) or denials (deny) an admin sets in
-- Administration > Access Control. Deny always wins over allow, which wins over
-- the role default. An admin always sees everything (safety net).

CREATE TABLE IF NOT EXISTS user_page_permissions (
    user_id     VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page_key    VARCHAR NOT NULL,
    effect      VARCHAR NOT NULL CHECK (effect IN ('allow', 'deny')),
    granted_by  VARCHAR REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, page_key)
);

CREATE INDEX IF NOT EXISTS idx_user_page_permissions_user ON user_page_permissions(user_id);
