import { useState } from "react";
import { useNavigate } from "@remix-run/react";
import { Box, Button, Center, Heading, Stack, Text } from "@chakra-ui/react";
import { useAuth } from "@context/auth-context";
import { createPasskeyCredential, getPasskeyCredential } from "@helpers/passkey-browser";

export default function LoginPage() {
  const { beginPasskeyRegistration, finishPasskeyRegistration, beginPasskeyLogin, finishPasskeyLogin } = useAuth();
  const navigate = useNavigate();
  const [notice, setNotice] = useState<{ type: "info" | "error"; message: string } | null>(null);
  const [working, setWorking] = useState(false);

  async function handlePasskeyLogin() {
    setNotice(null);
    setWorking(true);
    try {
      const options = await beginPasskeyLogin();
      const credential = await getPasskeyCredential(options);
      await finishPasskeyLogin(credential);
      setNotice({ type: "info", message: "Đã đăng nhập bằng passkey." });
      navigate("/", { replace: true });
    } catch (e) {
      setNotice({ type: "error", message: e instanceof Error ? e.message : "Đăng nhập passkey thất bại." });
    } finally {
      setWorking(false);
    }
  }

  async function handlePasskeyRegister() {
    const username = prompt("Nhập username cho passkey");
    if (!username?.trim()) return;
    setNotice(null);
    setWorking(true);
    try {
      const displayName = username.trim();
      const options = await beginPasskeyRegistration(displayName);
      const credential = await createPasskeyCredential(options);
      await finishPasskeyRegistration(displayName, credential);
      setNotice({ type: "info", message: "Đã đăng ký passkey cho account hiện tại." });
      navigate("/", { replace: true });
    } catch (e) {
      setNotice({ type: "error", message: e instanceof Error ? e.message : "Đăng ký passkey thất bại." });
    } finally {
      setWorking(false);
    }
  }

  return (
    <Center
      minH="100dvh"
      p="4"
      bg="var(--auth-page-gradient)"
    >
      <Stack
        gap="6"
        w="full"
        maxW="sm"
        bg="var(--auth-card-bg)"
        borderWidth="1px"
        borderColor="var(--auth-card-border)"
        rounded="xl"
        p={{ base: "6", md: "8" }}
        boxShadow="var(--auth-card-shadow)"
        backdropFilter="blur(18px)"
      >
        <Stack gap="1" textAlign="center">
          <Heading size="xl" color="var(--auth-heading)">Codex Proxy</Heading>
          <Text color="var(--auth-muted)" fontSize="sm">
            Đăng nhập để quản lý account & điều khiển Codex từ xa
          </Text>
        </Stack>

        <Stack gap="3">
          <Button
            colorPalette="green"
            variant="outline"
            borderColor="var(--auth-primary-outline)"
            color="var(--auth-primary-text)"
            _hover={{ bg: "var(--auth-primary-hover)" }}
            loading={working}
            onClick={() => void handlePasskeyLogin()}
          >
            Login with passkey
          </Button>
          <Button
            variant="outline"
            borderColor="var(--auth-outline)"
            color="var(--auth-outline-text)"
            _hover={{ bg: "var(--auth-outline-hover)" }}
            disabled={working}
            onClick={() => void handlePasskeyRegister()}
          >
            Register passkey
          </Button>
        </Stack>

        {notice && (
          <Box
            rounded="md"
            px="3"
            py="2"
            fontSize="sm"
            bg={notice.type === "error" ? "red.subtle" : "bg.muted"}
            color={notice.type === "error" ? "red.fg" : "fg.muted"}
          >
            {notice.message}
          </Box>
        )}
      </Stack>
    </Center>
  );
}
