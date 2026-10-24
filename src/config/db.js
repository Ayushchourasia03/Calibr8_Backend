import dotenv from "dotenv";
dotenv.config();
import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaPg } from "@prisma/adapter-pg";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const dbUrl = process.env.DATABASE_URL || "postgresql://localhost:5432/calibr8";

let adapter;
if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes("neon.tech")) {
  adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
} else {
  adapter = new PrismaPg({ connectionString: dbUrl });
}

const prisma = new PrismaClient({ adapter });

export default prisma;
