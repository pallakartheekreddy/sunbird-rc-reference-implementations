-- Databases the protocol services connect to, created at first Postgres start.
--
-- POSTGRES_DB only creates `registry`. identity-service, credential-schema and
-- credentials-service each point at their own database, and Prisma will not
-- create a missing one reliably — it fails at boot with "database ... does not
-- exist".
--
-- Plain SQL, not a shell script, on purpose: the Postgres entrypoint runs *.sql
-- through psql directly, with no shebang and no executable bit to get wrong. A
-- .sh file mounted read-only from the host failed here with
-- "/bin/bash: bad interpreter: Permission denied", and the entrypoint carried on
-- to start the server anyway — so the databases and schemas below were silently
-- never created, and the registry quietly wrote its tables to `public` instead.
--
-- Runs from /docker-entrypoint-initdb.d, so it executes ONCE on an empty data
-- directory. `docker compose down -v` to re-run it. No IF NOT EXISTS is needed
-- (and Postgres has none for CREATE DATABASE) for exactly that reason.
CREATE DATABASE identity;
CREATE DATABASE credential;
CREATE DATABASE credential_schema;

-- The Authority Service owns its own database, for the same reason as the three
-- above: it is a separate Prisma service with its own migration state. The shadow
-- database is Prisma's, used to diff migrations at deploy time; it is not optional
-- and the service will not start its migration step without one.
CREATE DATABASE authority;
CREATE DATABASE authority_shadow;

-- Keycloak's own database. Without it Keycloak runs `start-dev` on an embedded H2
-- inside the container's writable layer, which is destroyed whenever the container is
-- recreated. --import-realm then re-imports every realm and mints a NEW service-account
-- user for each client, while the Authority Service's TenantMembership rows -- here, in
-- durable Postgres -- go on naming the previous subjects. Every tenant becomes invisible
-- to its own administrator, reported as "this resource already exists but is not visible
-- to the principal this script is using", which names neither Keycloak nor the re-import.
CREATE DATABASE keycloak;

-- No per-use-case database. Age, Agriculture and Education share the registry's
-- database and are separated by their own tables/entities (Anand's answer 10,
-- PRODUCT and DESIGN §7). These three remain separate because they are NOT
-- use-case data: each is a distinct Prisma service that owns its own
-- `_prisma_migrations` table, and merging them would have three services
-- overwriting one another's migration state.
