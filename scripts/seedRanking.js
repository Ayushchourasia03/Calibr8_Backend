import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const users = [
    { name: "Riya Verma", score: 48210, rating: 1790, streak: 132, strict: 88, tier: "Zenith II" },
    { name: "Kabir Singh", score: 46950, rating: 1690, streak: 97, strict: 74, tier: "Eclipse III" },
    { name: "Ananya Gupta", score: 44120, rating: 1610, streak: 61, strict: 91, tier: "Eclipse II" },
    { name: "Mohit Yadav", score: 41300, rating: 1540, streak: 88, strict: 52, tier: "Eclipse I" },
    { name: "Sneha Rao", score: 39870, rating: 1470, streak: 40, strict: 67, tier: "Aurora III" },
    { name: "Dev Malhotra", score: 37010, rating: 1390, streak: 73, strict: 80, tier: "Aurora II" },
    { name: "Isha Kapoor", score: 33400, rating: 1310, streak: 29, strict: 58, tier: "Aurora I" },
    { name: "Arjun Nair", score: 30120, rating: 1230, streak: 51, strict: 49, tier: "Prism II" },
    { name: "Meera Joshi", score: 26800, rating: 1150, streak: 18, strict: 36, tier: "Prism I" },
    { name: "Rahul Das", score: 24300, rating: 1120, streak: 22, strict: 45, tier: "Prism I" },
  ];

  // IMPORTANT: Use same college as your own account, so you appear in same ranking
  const MY_COLLEGE = "AKGEC"; 

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    await prisma.user.upsert({
      where: { email: `rank${i}@test.com` },
      update: {
        score: u.score,
        rating: u.rating,
        streak: u.streak,
        strictPercent: u.strict,
        tier: u.tier,
        college: MY_COLLEGE,
        batch: "2026",
        state: "UP",
        country: "India"
      },
      create: {
        email: `rank${i}@test.com`,
        name: u.name,
        passwordHash: "$2a$10$seed",
        score: u.score,
        rating: u.rating,
        streak: u.streak,
        strictPercent: u.strict,
        tier: u.tier,
        college: MY_COLLEGE,
        batch: "2026",
        state: "UP",
        country: "India",
        onboarded: true
      }
    });
  }

  console.log(`✅ Seeded 10 users for college: ${MY_COLLEGE}`);
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());