CREATE TABLE IF NOT EXISTS draft_revisions (
 draft_id text PRIMARY KEY NOT NULL,
 revision integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS post_approvals (
 id text PRIMARY KEY NOT NULL,
 draft_id text NOT NULL,
 connection_id text NOT NULL,
 user_id text NOT NULL,
 actor text NOT NULL,
 channel text NOT NULL CHECK (channel IN ('chat', 'ui')),
 payload_hash text NOT NULL,
 content_hash text NOT NULL,
 account_hash text NOT NULL,
 scheduled_for integer,
 revision integer NOT NULL,
 state text NOT NULL DEFAULT 'approved',
 approved_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS post_approvals_lookup_idx ON post_approvals (draft_id, connection_id, state);
CREATE TABLE IF NOT EXISTS publish_audit (
 id text PRIMARY KEY NOT NULL,
 event text NOT NULL,
 actor text NOT NULL,
 draft_id text,
 target_id text,
 detail text NOT NULL DEFAULT '{}',
 created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS publish_audit_created_idx ON publish_audit (created_at);
CREATE TABLE IF NOT EXISTS publish_dispatches (
 target_id text PRIMARY KEY NOT NULL,
 approval_id text NOT NULL,
 account_hash text NOT NULL,
 content_hash text NOT NULL,
 state text NOT NULL DEFAULT 'uncertain',
 started_at integer NOT NULL,
 remote_post_id text,
 remote_url text
);
CREATE TABLE IF NOT EXISTS publish_dedup (
 account_hash text NOT NULL,
 content_hash text NOT NULL,
 target_id text NOT NULL,
 reserved_at integer NOT NULL,
 PRIMARY KEY (account_hash, content_hash)
);
INSERT OR IGNORE INTO draft_revisions (draft_id, revision) SELECT id, 0 FROM drafts;
CREATE TRIGGER IF NOT EXISTS gate_draft_create AFTER INSERT ON drafts BEGIN
 INSERT OR IGNORE INTO draft_revisions (draft_id, revision) VALUES (NEW.id,0);
 INSERT INTO publish_audit (id,event,actor,draft_id,detail,created_at) VALUES (lower(hex(randomblob(16))),'create','database',NEW.id,'{}',CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS gate_draft_edit AFTER UPDATE OF title, base_body, selected_connection_ids ON drafts BEGIN
 UPDATE draft_revisions SET revision = revision + 1 WHERE draft_id = NEW.id;
 UPDATE post_approvals SET state = 'needs_reapproval' WHERE draft_id = NEW.id AND state = 'approved';
 INSERT INTO publish_audit (id,event,actor,draft_id,detail,created_at) VALUES (lower(hex(randomblob(16))),'edit','database',NEW.id,'{}',CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS gate_draft_delete AFTER DELETE ON drafts BEGIN
 UPDATE draft_revisions SET revision = revision + 1 WHERE draft_id = OLD.id;
 UPDATE post_approvals SET state = 'needs_reapproval' WHERE draft_id = OLD.id AND state = 'approved';
 INSERT INTO publish_audit (id,event,actor,draft_id,detail,created_at) VALUES (lower(hex(randomblob(16))),'edit','database',OLD.id,'{}',CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS gate_draft_variants_insert AFTER INSERT ON draft_variants BEGIN
 UPDATE draft_revisions SET revision = revision + 1 WHERE draft_id = NEW.draft_id;
 UPDATE post_approvals SET state = 'needs_reapproval' WHERE draft_id = NEW.draft_id AND state = 'approved';
 INSERT INTO publish_audit (id,event,actor,draft_id,detail,created_at) VALUES (lower(hex(randomblob(16))),'edit','database',NEW.draft_id,'{}',CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS gate_draft_variants_update AFTER UPDATE ON draft_variants BEGIN
 UPDATE draft_revisions SET revision = revision + 1 WHERE draft_id = NEW.draft_id;
 UPDATE post_approvals SET state = 'needs_reapproval' WHERE draft_id = NEW.draft_id AND state = 'approved';
 INSERT INTO publish_audit (id,event,actor,draft_id,detail,created_at) VALUES (lower(hex(randomblob(16))),'edit','database',NEW.draft_id,'{}',CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS gate_draft_variants_delete AFTER DELETE ON draft_variants BEGIN
 UPDATE draft_revisions SET revision = revision + 1 WHERE draft_id = OLD.draft_id;
 UPDATE post_approvals SET state = 'needs_reapproval' WHERE draft_id = OLD.draft_id AND state = 'approved';
 INSERT INTO publish_audit (id,event,actor,draft_id,detail,created_at) VALUES (lower(hex(randomblob(16))),'edit','database',OLD.draft_id,'{}',CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS gate_draft_media_insert AFTER INSERT ON draft_media BEGIN
 UPDATE draft_revisions SET revision = revision + 1 WHERE draft_id = NEW.draft_id;
 UPDATE post_approvals SET state = 'needs_reapproval' WHERE draft_id = NEW.draft_id AND state = 'approved';
 INSERT INTO publish_audit (id,event,actor,draft_id,detail,created_at) VALUES (lower(hex(randomblob(16))),'edit','database',NEW.draft_id,'{}',CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS gate_draft_media_update AFTER UPDATE ON draft_media BEGIN
 UPDATE draft_revisions SET revision = revision + 1 WHERE draft_id = NEW.draft_id;
 UPDATE post_approvals SET state = 'needs_reapproval' WHERE draft_id = NEW.draft_id AND state = 'approved';
 INSERT INTO publish_audit (id,event,actor,draft_id,detail,created_at) VALUES (lower(hex(randomblob(16))),'edit','database',NEW.draft_id,'{}',CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS gate_draft_media_delete AFTER DELETE ON draft_media BEGIN
 UPDATE draft_revisions SET revision = revision + 1 WHERE draft_id = OLD.draft_id;
 UPDATE post_approvals SET state = 'needs_reapproval' WHERE draft_id = OLD.draft_id AND state = 'approved';
 INSERT INTO publish_audit (id,event,actor,draft_id,detail,created_at) VALUES (lower(hex(randomblob(16))),'edit','database',OLD.draft_id,'{}',CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS gate_connection_edit AFTER UPDATE OF platform, handle, instance_url ON connections
WHEN OLD.platform IS NOT NEW.platform OR OLD.handle IS NOT NEW.handle OR OLD.instance_url IS NOT NEW.instance_url
BEGIN
 UPDATE post_approvals SET state = 'needs_reapproval' WHERE connection_id = NEW.id AND state = 'approved';
 INSERT INTO publish_audit (id,event,actor,draft_id,detail,created_at) VALUES (lower(hex(randomblob(16))),'edit','database',NULL,json_object('connectionId',NEW.id),CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS gate_approval_audit AFTER INSERT ON post_approvals BEGIN
 INSERT INTO publish_audit (id,event,actor,draft_id,detail,created_at) VALUES (lower(hex(randomblob(16))),'approve',NEW.actor,NEW.draft_id,json_object('approvalId',NEW.id,'hash',NEW.payload_hash,'channel',NEW.channel,'connectionId',NEW.connection_id),NEW.approved_at);
END;

INSERT OR IGNORE INTO publish_dispatches (target_id,approval_id,account_hash,content_hash,state,started_at,remote_post_id,remote_url)
SELECT id,'legacy','legacy','legacy','legacy_reconciliation_required',updated_at,remote_post_id,remote_url FROM publish_targets WHERE attempt_count > 0 OR remote_post_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS gate_schedule_edit AFTER UPDATE OF scheduled_for ON publish_targets
WHEN OLD.scheduled_for IS NOT NEW.scheduled_for
BEGIN
 UPDATE post_approvals SET state='needs_reapproval' WHERE draft_id=NEW.draft_id AND connection_id=NEW.connection_id AND scheduled_for IS NOT NEW.scheduled_for AND state='approved';
 INSERT INTO publish_audit (id,event,actor,draft_id,target_id,detail,created_at) VALUES (lower(hex(randomblob(16))),'schedule','database',NEW.draft_id,NEW.id,json_object('scheduledFor',NEW.scheduled_for),CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
