-- Wilhelm's default Supabase vector store.
-- Uses OpenAI text-embedding-3-small (1536 dimensions).

create extension if not exists vector with schema extensions;

create table if not exists public.documents (
  id text primary key,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding extensions.vector(1536) not null,
  created_at timestamptz not null default now()
);

create index if not exists documents_embedding_cosine_idx
  on public.documents using hnsw (embedding extensions.vector_cosine_ops);

alter table public.documents enable row level security;
revoke all on public.documents from anon, authenticated;
grant select, insert, update, delete on public.documents to service_role;

create or replace function public.match_documents(
  query_embedding extensions.vector(1536),
  match_count int default 5,
  filter_domain text default null
)
returns table (
  id text,
  content text,
  metadata jsonb,
  similarity double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    d.id,
    d.content,
    d.metadata,
    1 - (d.embedding <=> query_embedding) as similarity
  from public.documents d
  where filter_domain is null
     or d.metadata ->> 'domain' = filter_domain
  order by d.embedding <=> query_embedding
  limit greatest(1, least(match_count, 100));
$$;

revoke all on function public.match_documents(extensions.vector, int, text) from public, anon, authenticated;
grant execute on function public.match_documents(extensions.vector, int, text) to service_role;
