import { Box, SimpleGrid, Text } from "@chakra-ui/react";

export function StatsGrid({
  using, active, limited, totalRequests, accountCount,
}: {
  using: number; active: number; limited: number;
  totalRequests: number; accountCount: number;
}) {
  const items = [
    { label: "In use", value: using || active },
    { label: "Rate limited", value: limited },
    { label: "Total requests", value: totalRequests.toLocaleString() },
    { label: "Total accounts", value: accountCount },
  ];
  return (
    <SimpleGrid columns={{ base: 2, md: 4 }} gap="3" mt="4">
      {items.map((it) => (
        <Box key={it.label} bg="bg.panel" borderWidth="1px" borderColor="border" rounded="lg" p="4">
          <Text fontSize="xs" color="fg.muted" textTransform="uppercase" letterSpacing="wider">
            {it.label}
          </Text>
          <Text fontSize="3xl" fontWeight="bold" lineHeight="1.1" mt="1.5">
            {it.value}
          </Text>
        </Box>
      ))}
    </SimpleGrid>
  );
}
