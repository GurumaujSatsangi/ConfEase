# ConfEase's PostgreSQL image - the official postgres image plus this
# project's own schema, applied automatically the first time the
# container starts against an empty data directory.
#
# This is a separate image from the app (see the root Dockerfile), not
# merged into it. Running the database as its own container, independent
# of the application process, is the standard pattern for a reason: the
# two have entirely different lifecycles. The app image gets rebuilt and
# replaced on every deploy; the database's data must survive every one of
# those deploys untouched. Baking Postgres into the app's own image would
# tie the database's data to the app container's filesystem, so a routine
# app update (or a crash and restart) risks taking the database down with
# it, or worse, silently discarding its data if the container is replaced
# rather than restarted. Keeping it separate also means this image can be
# updated to a new Postgres point release independently of the app, and
# the official postgres image continues to carry upstream security
# patches - this Dockerfile just adds one thing on top of it.
FROM postgres:17-alpine

# Postgres's own entrypoint script runs every .sql/.sh file in this
# directory, in filename order, exactly once - the first time the
# container starts with an empty data directory (i.e. against a fresh,
# unnamed volume). See db/schema.sql's own header comment for why this is
# a single consolidated schema file rather than db/migrations/'s
# incremental history.
COPY schema.sql /docker-entrypoint-initdb.d/01-schema.sql
