-- Phase H: semantic/vector search moved to the @tq/ext-search-semantic
-- extension, which owns its own sqlite store. Core is FTS-only now, so the
-- in-core embedding queue is dead. (task_vec was a runtime-created vec0 virtual
-- table; it's left untouched here because dropping a virtual table requires the
-- sqlite-vec module loaded, which core no longer loads. It is inert — nothing
-- reads it — and is superseded by the extension's own index.)
DROP TABLE IF EXISTS embedding_queue;
