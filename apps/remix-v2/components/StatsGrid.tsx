import { Box, Flex, SimpleGrid, Text } from "@chakra-ui/react";

function ActivityIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}
function AlertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function ZapIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}
function UsersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

const STATS = [
  { key: "using",    label: "Đang dùng",      color: "green",  Icon: ActivityIcon },
  { key: "limited",  label: "Hết hạn mức",    color: "yellow", Icon: AlertIcon },
  { key: "requests", label: "Tổng requests",  color: "blue",   Icon: ZapIcon },
  { key: "accounts", label: "Tổng accounts",  color: "gray",   Icon: UsersIcon },
];

export function StatsGrid({
  using, active, limited, totalRequests, accountCount,
}: {
  using: number; active: number; limited: number;
  totalRequests: number; accountCount: number;
}) {
  const values = [using || active, limited, totalRequests, accountCount];

  return (
    <SimpleGrid columns={{ base: 2, md: 4 }} gap="3" mt="4">
      {STATS.map((s, i) => (
        <Box
          key={s.key}
          bg="bg.panel"
          borderWidth="1px"
          borderColor="border"
          rounded="xl"
          p="4"
          shadow="xs"
        >
          <Flex justify="space-between" align="center" mb="3">
            <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="widest" fontWeight="medium">
              {s.label}
            </Text>
            <Flex
              align="center"
              justify="center"
              boxSize="6"
              rounded="md"
              bg={`${s.color}.subtle`}
              color={`${s.color}.fg`}
              flexShrink={0}
            >
              <s.Icon />
            </Flex>
          </Flex>
          <Text fontSize="2xl" fontWeight="bold" lineHeight="1" color="fg">
            {typeof values[i] === "number" ? (values[i] as number).toLocaleString() : values[i]}
          </Text>
        </Box>
      ))}
    </SimpleGrid>
  );
}
