const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const provider = await prisma.provider.update({
    where: { id: '17c738c9-84ae-4e40-a994-98bff95178bc' },
    data: { baseUrl: 'http://localhost:11434' },
  });
  console.log('Updated provider baseUrl:', provider.baseUrl);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
