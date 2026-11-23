// Imported FIRST by tests that load the app but never query the database:
// point Prisma at an unreachable local address and blank the judge, so
// nothing can reach the database / CodeBox configured in .env.
process.env.DATABASE_URL = "postgresql://no-db:no-db@127.0.0.1:1/no_database";
process.env.CODEBOX_URL = "";
process.env.CODEBOX_TOKEN = "";
