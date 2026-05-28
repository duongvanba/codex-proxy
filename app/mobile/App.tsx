import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Modal,
} from "react-native";
import { createCodexApi } from "./src/openaiCodexApi";
import type { ApprovalRequest, ChatMessage, ChatSummary, FolderNode, Host, Project, Session } from "./src/types";

type Screen = "login" | "hosts" | "projects" | "chat";

const api = createCodexApi();
const ThemeContext = createContext({ darkMode: false, toggleDarkMode: () => {} });

function useTheme() {
  return useContext(ThemeContext);
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("login");
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [host, setHost] = useState<Host | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [chat, setChat] = useState<ChatSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [activeApproval, setActiveApproval] = useState<ApprovalRequest | null>(null);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [folderTree, setFolderTree] = useState<FolderNode[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<FolderNode | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [darkMode, setDarkMode] = useState(false);
  const [apiBase, setApiBase] = useState("https://chatgpt.com");
  const [accessToken, setAccessToken] = useState("");
  const [accountId, setAccountId] = useState("");
  const themeValue = useMemo(
    () => ({ darkMode, toggleDarkMode: () => setDarkMode((value) => !value) }),
    [darkMode]
  );

  async function run<T>(task: () => Promise<T>) {
    setBusy(true);
    setError(null);
    try {
      return await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function login() {
    const next = await run(() => api.signInWithGoogle({ accessToken, accountId, apiBase }));
    if (!next) return;
    setSession(next);
  }

  async function authorize() {
    if (!session) return;
    const next = await run(() => api.authorizeRemoteControl(session));
    if (!next) return;
    setSession(next);
    const list = await run(() => api.listHosts(next));
    if (!list) return;
    setHosts(list);
    setScreen("hosts");
  }

  async function refreshHosts(active = session) {
    if (!active) return;
    const list = await run(() => api.listHosts(active));
    if (list) setHosts(list);
  }

  async function openHost(nextHost: Host) {
    if (!session) return;
    setHost(nextHost);
    const list = await run(() => api.listProjects(session, nextHost.id));
    if (!list) return;
    setProjects(list);
    setScreen("projects");
  }

  async function openCreateProjectModal() {
    if (!session || !host) return;
    setSelectedFolder(null);
    setProjectModalOpen(true);
    const folders = await run(() => api.listFolders(session, host.id));
    if (folders) setFolderTree(folders);
  }

  async function createProject() {
    if (!session || !host || !selectedFolder) return;
    const created = await run(() => api.createProject(session, host.id, selectedFolder.path));
    if (!created) return;
    setProjects((items) => [created, ...items]);
    setProjectModalOpen(false);
    setSelectedFolder(null);
  }

  async function createChat(projectToUpdate: Project) {
    if (!session || !host) return;
    const created = await run(() => api.createChat(session, host.id, projectToUpdate.id));
    if (!created) return;
    const nextProject = {
      ...projectToUpdate,
      chats: [created, ...projectToUpdate.chats],
    };
    setProjects((items) => items.map((item) => (item.id === projectToUpdate.id ? nextProject : item)));
    await openChat(nextProject, created);
  }

  async function openChat(nextProject: Project, nextChat: ChatSummary) {
    if (!session || !host) return;
    setProject(nextProject);
    setChat(nextChat);
    const detail = await run(() => api.readChat(session, host.id, nextProject.id, nextChat.id));
    if (!detail) return;
    setMessages(detail.messages);
    setApprovals(detail.approvals);
    setActiveApproval(detail.approvals[0] ?? null);
    setScreen("chat");
  }

  async function send() {
    if (!session || !host || !project || !chat || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    const optimistic: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    };
    setMessages((items) => [...items, optimistic]);
    const sent = await run(() => api.sendMessage(session, host.id, project.id, chat.id, text));
    if (sent) {
      setMessages((items) => items.map((item) => (item.id === optimistic.id ? sent : item)));
    }
  }

  async function approve(approval: ApprovalRequest) {
    if (!session || !host || !chat) return;
    await run(() => api.approveRequest(session, host.id, chat.id, approval.id));
    setApprovals((items) => items.filter((item) => item.id !== approval.id));
    setActiveApproval((current) => (current?.id === approval.id ? null : current));
    setMessages((items) => [
      ...items,
      {
        id: `approval-${Date.now()}`,
        role: "system",
        text: `Approved: ${approval.command}`,
        createdAt: new Date().toISOString(),
      },
    ]);
  }

  function deny(approval: ApprovalRequest) {
    setApprovals((items) => items.filter((item) => item.id !== approval.id));
    setActiveApproval((current) => (current?.id === approval.id ? null : current));
    setMessages((items) => [
      ...items,
      {
        id: `denied-${Date.now()}`,
        role: "system",
        text: `Denied: ${approval.command}`,
        createdAt: new Date().toISOString(),
      },
    ]);
  }

  useEffect(() => {
    if (!activeApproval && approvals.length > 0 && screen === "chat") {
      setActiveApproval(approvals[0]);
    }
  }, [activeApproval, approvals, screen]);

  return (
    <ThemeContext.Provider value={themeValue}>
      <SafeAreaView style={[styles.safe, darkMode && styles.safeDark]}>
        <StatusBar style={darkMode ? "light" : "dark"} />
        <GradientBackground>
          <KeyboardAvoidingView behavior={Platform.select({ ios: "padding" })} style={styles.flex}>
            <View style={styles.shell}>
              {screen !== "chat" ? <TopBar screen={screen} busy={busy} onBack={() => goBack(screen, setScreen)} /> : null}
              {error ? <Text style={styles.error}>{error}</Text> : null}
              {screen === "login" ? (
                <LoginScreen
                  session={session}
                  busy={busy}
                  apiBase={apiBase}
                  accessToken={accessToken}
                  accountId={accountId}
                  onApiBaseChange={setApiBase}
                  onAccessTokenChange={setAccessToken}
                  onAccountIdChange={setAccountId}
                  onLogin={login}
                  onAuthorize={authorize}
                />
              ) : null}
              {screen === "hosts" ? (
                <HostsScreen hosts={hosts} busy={busy} onRefresh={() => refreshHosts()} onOpen={openHost} />
              ) : null}
              {screen === "projects" && host ? (
                <ProjectsScreen
                  host={host}
                  projects={projects}
                  onOpenChat={openChat}
                  onCreateProject={openCreateProjectModal}
                  onCreateChat={createChat}
                />
              ) : null}
              {screen === "chat" && host && project && chat ? (
                <ChatScreen
                  host={host}
                  project={project}
                  chat={chat}
                  messages={messages}
                  approvals={approvals}
                  draft={draft}
                  busy={busy}
                  onDraftChange={setDraft}
                  onSend={send}
                  onApprove={approve}
                  onDeny={deny}
                  activeApproval={activeApproval}
                  onOpenApproval={setActiveApproval}
                  onCloseApproval={() => setActiveApproval(null)}
                  onBack={() => goBack(screen, setScreen)}
                />
              ) : null}
              <CreateProjectModal
                open={projectModalOpen}
                folders={folderTree}
                selectedFolder={selectedFolder}
                onSelectFolder={setSelectedFolder}
                onClose={() => setProjectModalOpen(false)}
                onCreate={createProject}
              />
            </View>
          </KeyboardAvoidingView>
        </GradientBackground>
      </SafeAreaView>
    </ThemeContext.Provider>
  );
}

function GradientBackground({ children }: { children: ReactNode }) {
  const { darkMode } = useTheme();
  if (Platform.OS === "web") {
    return <View style={[styles.gradient, darkMode ? styles.webGradientDark : styles.webGradient]}>{children}</View>;
  }

  return (
    <LinearGradient
      colors={darkMode ? ["#0b1120", "#101827", "#18122b"] : ["#f8fbff", "#edf4ff", "#f7f7fb"]}
      style={styles.gradient}
    >
      {children}
    </LinearGradient>
  );
}

function goBack(screen: Screen, setScreen: (screen: Screen) => void) {
  if (screen === "chat") setScreen("projects");
  if (screen === "projects") setScreen("hosts");
  if (screen === "hosts") setScreen("login");
}

function TopBar({ screen, busy, onBack }: { screen: Screen; busy: boolean; onBack: () => void }) {
  const { darkMode } = useTheme();
  return (
    <View style={[styles.topBar, darkMode && styles.topBarDark]}>
      <View style={styles.titleRow}>
        {screen !== "login" ? (
          <Pressable accessibilityLabel="Back" onPress={onBack} style={[styles.backIconButton, darkMode && styles.iconButtonDark]}>
            <Text style={[styles.backIcon, darkMode && styles.textDark]}>‹</Text>
          </Pressable>
        ) : null}
        <View style={styles.flex}>
          <Text style={[styles.title, darkMode && styles.textDark]}>{topTitle(screen)}</Text>
          <Text style={[styles.subtitle, darkMode && styles.subtleTextDark]}>{screenLabel(screen)}</Text>
        </View>
      </View>
      <View style={styles.topActions}>
        {busy ? <ActivityIndicator color="#1f6feb" /> : null}
        <ThemeToggle />
      </View>
    </View>
  );
}

function ThemeToggle() {
  const { darkMode, toggleDarkMode } = useTheme();
  return (
    <Pressable accessibilityLabel="Toggle dark mode" onPress={toggleDarkMode} style={[styles.themeToggle, darkMode && styles.themeToggleDark]}>
      <Text style={[styles.themeToggleText, darkMode && styles.textDark]}>{darkMode ? "☀" : "☾"}</Text>
    </Pressable>
  );
}

function LoginScreen({
  session,
  busy,
  apiBase,
  accessToken,
  accountId,
  onApiBaseChange,
  onAccessTokenChange,
  onAccountIdChange,
  onLogin,
  onAuthorize,
}: {
  session: Session | null;
  busy: boolean;
  apiBase: string;
  accessToken: string;
  accountId: string;
  onApiBaseChange: (value: string) => void;
  onAccessTokenChange: (value: string) => void;
  onAccountIdChange: (value: string) => void;
  onLogin: () => void;
  onAuthorize: () => void;
}) {
  const { darkMode } = useTheme();
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={[styles.hero, darkMode && styles.surfaceDark]}>
        <Text style={[styles.heroTitle, darkMode && styles.textDark]}>Sign in and authorize remote control</Text>
        <Text style={[styles.bodyText, darkMode && styles.subtleTextDark]}>
          API calls use the Codex headers from codex_api.md. Paste a ChatGPT OAuth access token and account id to
          connect this preview to the real backend.
        </Text>
      </View>
      <View style={[styles.hero, darkMode && styles.surfaceDark]}>
        <Field
          label="API base"
          value={apiBase}
          onChangeText={onApiBaseChange}
          placeholder="https://chatgpt.com"
          darkMode={darkMode}
        />
        <Field
          label="Access token"
          value={accessToken}
          onChangeText={onAccessTokenChange}
          placeholder="Bearer token from ChatGPT/OpenAI OAuth"
          darkMode={darkMode}
          secureTextEntry
        />
        <Field
          label="ChatGPT account id"
          value={accountId}
          onChangeText={onAccountIdChange}
          placeholder="Optional but usually required"
          darkMode={darkMode}
        />
      </View>
      <PrimaryButton disabled={busy} title={session ? `Signed in as ${session.email}` : "Use API token"} onPress={onLogin} />
      <PrimaryButton disabled={busy || !session} title="Authorize Remote Control" onPress={onAuthorize} secondary={!session} />
    </ScrollView>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  darkMode,
  secureTextEntry,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  darkMode: boolean;
  secureTextEntry?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, darkMode && styles.textDark]}>{label}</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={darkMode ? "#8b949e" : "#8c959f"}
        secureTextEntry={secureTextEntry}
        style={[styles.fieldInput, darkMode && styles.inputDark]}
      />
    </View>
  );
}

function HostsScreen({
  hosts,
  busy,
  onRefresh,
  onOpen,
}: {
  hosts: Host[];
  busy: boolean;
  onRefresh: () => void;
  onOpen: (host: Host) => void;
}) {
  const { darkMode } = useTheme();
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.rowBetween}>
        <Text style={[styles.sectionTitle, darkMode && styles.textDark]}>Hosts</Text>
        <Pressable disabled={busy} onPress={onRefresh} style={[styles.smallButton, darkMode && styles.secondaryButtonDark]}>
          <Text style={[styles.smallButtonText, darkMode && styles.textDark]}>Refresh</Text>
        </Pressable>
      </View>
      {hosts.map((host) => (
        <Pressable key={host.id} onPress={() => onOpen(host)} style={[styles.card, darkMode && styles.surfaceDark]}>
          <View style={styles.rowBetween}>
            <Text style={[styles.cardTitle, darkMode && styles.textDark]}>{host.name}</Text>
            <StatusBadge value={host.status} />
          </View>
          <Text style={[styles.meta, darkMode && styles.subtleTextDark]}>{host.platform} • Last seen {host.lastSeen}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function ProjectsScreen({
  host,
  projects,
  onOpenChat,
  onCreateProject,
  onCreateChat,
}: {
  host: Host;
  projects: Project[];
  onOpenChat: (project: Project, chat: ChatSummary) => void;
  onCreateProject: () => void;
  onCreateChat: (project: Project) => void;
}) {
  const { darkMode } = useTheme();
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.rowBetween}>
        <Text style={[styles.sectionTitle, darkMode && styles.textDark]}>{host.name}</Text>
        <Pressable accessibilityLabel="Add project" onPress={onCreateProject} style={styles.iconButton}>
          <Text style={styles.plusIcon}>+</Text>
        </Pressable>
      </View>
      {projects.map((project) => (
        <View key={project.id} style={[styles.card, darkMode && styles.surfaceDark]}>
          <View style={styles.rowBetween}>
            <Text style={[styles.cardTitle, darkMode && styles.textDark]}>{project.name}</Text>
            <Pressable accessibilityLabel={`Add chat to ${project.name}`} onPress={() => onCreateChat(project)} style={[styles.projectPlusButton, darkMode && styles.iconButtonDark]}>
              <Text style={[styles.projectPlusText, darkMode && styles.textDark]}>+</Text>
            </Pressable>
          </View>
          <Text style={[styles.meta, darkMode && styles.subtleTextDark]}>{project.path}</Text>
          <View style={styles.chatList}>
            {project.chats.map((chat) => (
              <Pressable key={chat.id} onPress={() => onOpenChat(project, chat)} style={[styles.chatRow, darkMode && styles.chatRowDark]}>
                <View style={styles.flex}>
                  <Text style={[styles.chatTitle, darkMode && styles.textDark]}>{chat.title}</Text>
                  <Text style={[styles.meta, darkMode && styles.subtleTextDark]}>{chat.updatedAt}</Text>
                </View>
                <StatusBadge value={chat.status} />
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

function ChatScreen({
  host,
  project,
  chat,
  messages,
  approvals,
  draft,
  busy,
  onDraftChange,
  onSend,
  onApprove,
  onDeny,
  activeApproval,
  onOpenApproval,
  onCloseApproval,
  onBack,
}: {
  host: Host;
  project: Project;
  chat: ChatSummary;
  messages: ChatMessage[];
  approvals: ApprovalRequest[];
  draft: string;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onApprove: (approval: ApprovalRequest) => void;
  onDeny: (approval: ApprovalRequest) => void;
  activeApproval: ApprovalRequest | null;
  onOpenApproval: (approval: ApprovalRequest) => void;
  onCloseApproval: () => void;
  onBack: () => void;
}) {
  const canSend = useMemo(() => draft.trim().length > 0 && !busy, [draft, busy]);
  const { darkMode } = useTheme();

  return (
    <View style={styles.chatScreen}>
      <View style={[styles.chatHeader, darkMode && styles.topBarDark]}>
        <Pressable accessibilityLabel="Back" onPress={onBack} style={[styles.chatBackButton, darkMode && styles.iconButtonDark]}>
          <Text style={[styles.chatBackIcon, darkMode && styles.textDark]}>‹</Text>
        </Pressable>
        <View style={styles.flex}>
          <Text style={[styles.cardTitle, darkMode && styles.textDark]}>{chat.title}</Text>
          <Text style={[styles.meta, darkMode && styles.subtleTextDark]}>{project.name} on {host.name}</Text>
        </View>
        <ThemeToggle />
      </View>
      <ScrollView contentContainerStyle={styles.messages}>
        {approvals.map((approval) => (
          <Pressable key={approval.id} style={styles.approvalCard} onPress={() => onOpenApproval(approval)}>
            <Text style={styles.approvalTitle}>{approval.title}</Text>
            <Text style={styles.command}>{approval.command}</Text>
            <View style={styles.rowBetween}>
              <StatusBadge value={approval.risk} />
              <Text style={styles.reviewText}>Review</Text>
            </View>
          </Pressable>
        ))}
        {messages.map((message) => (
          <View key={message.id} style={[styles.message, styles[message.role], darkMode && message.role === "assistant" && styles.assistantDark]}>
            <Text style={styles.messageRole}>{message.role}</Text>
            <Text style={[styles.messageText, darkMode && message.role === "assistant" && styles.textDark]}>{message.text}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={[styles.composer, darkMode && styles.topBarDark]}>
        <TextInput
          multiline
          value={draft}
          onChangeText={onDraftChange}
          placeholder="Nhắn thêm cho Codex..."
          style={[styles.composerInput, darkMode && styles.inputDark]}
          placeholderTextColor={darkMode ? "#8b949e" : "#8c959f"}
        />
        <Pressable disabled={!canSend} onPress={onSend} style={[styles.sendButton, !canSend && styles.disabled]}>
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
      <ApprovalModal
        approval={activeApproval}
        onAccept={(approval) => onApprove(approval)}
        onDeny={(approval) => onDeny(approval)}
        onClose={onCloseApproval}
      />
    </View>
  );
}

function ApprovalModal({
  approval,
  onAccept,
  onDeny,
  onClose,
}: {
  approval: ApprovalRequest | null;
  onAccept: (approval: ApprovalRequest) => void;
  onDeny: (approval: ApprovalRequest) => void;
  onClose: () => void;
}) {
  const { darkMode } = useTheme();
  return (
    <Modal visible={approval != null} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalCard, darkMode && styles.modalCardDark]}>
          <Text style={[styles.modalTitle, darkMode && styles.textDark]}>Codex needs permission</Text>
          <Text style={[styles.bodyText, darkMode && styles.subtleTextDark]}>Review this request before Codex continues on the remote host.</Text>
          {approval ? (
            <View style={[styles.modalCommandBox, darkMode && styles.commandBoxDark]}>
              <Text style={[styles.approvalTitle, darkMode && styles.textDark]}>{approval.title}</Text>
              <Text style={[styles.command, darkMode && styles.textDark]}>{approval.command}</Text>
              <StatusBadge value={`${approval.risk} risk`} />
            </View>
          ) : null}
          <View style={styles.modalActions}>
            <Pressable onPress={onClose} style={styles.modalGhostButton}>
              <Text style={styles.modalGhostText}>Later</Text>
            </Pressable>
            {approval ? (
              <Pressable onPress={() => onDeny(approval)} style={styles.modalDenyButton}>
                <Text style={styles.modalDenyText}>Deny</Text>
              </Pressable>
            ) : null}
            {approval ? (
              <Pressable onPress={() => onAccept(approval)} style={styles.modalAcceptButton}>
                <Text style={styles.modalAcceptText}>Accept</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

function CreateProjectModal({
  open,
  folders,
  selectedFolder,
  onSelectFolder,
  onClose,
  onCreate,
}: {
  open: boolean;
  folders: FolderNode[];
  selectedFolder: FolderNode | null;
  onSelectFolder: (folder: FolderNode) => void;
  onClose: () => void;
  onCreate: () => void;
}) {
  const { darkMode } = useTheme();
  return (
    <Modal visible={open} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={[styles.projectModalCard, darkMode && styles.modalCardDark]}>
          <Text style={[styles.modalTitle, darkMode && styles.textDark]}>Add project</Text>
          <Text style={[styles.bodyText, darkMode && styles.subtleTextDark]}>Choose a folder from this host to create a Codex project.</Text>
          <ScrollView style={[styles.folderTree, darkMode && styles.commandBoxDark]} contentContainerStyle={styles.folderTreeContent}>
            {folders.map((folder) => (
              <FolderTreeRow
                key={folder.id}
                node={folder}
                level={0}
                selectedPath={selectedFolder?.path ?? null}
                onSelect={onSelectFolder}
              />
            ))}
          </ScrollView>
          <View style={[styles.selectedFolderBox, darkMode && styles.commandBoxDark]}>
            <Text style={[styles.meta, darkMode && styles.subtleTextDark]}>Selected folder</Text>
            <Text style={[styles.selectedFolderText, darkMode && styles.textDark]}>{selectedFolder?.path ?? "No folder selected"}</Text>
          </View>
          <View style={styles.modalActions}>
            <Pressable onPress={onClose} style={styles.modalGhostButton}>
              <Text style={styles.modalGhostText}>Close</Text>
            </Pressable>
            <Pressable
              disabled={!selectedFolder}
              onPress={onCreate}
              style={[styles.modalAcceptButton, !selectedFolder && styles.disabled]}
            >
              <Text style={styles.modalAcceptText}>Create</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function FolderTreeRow({
  node,
  level,
  selectedPath,
  onSelect,
}: {
  node: FolderNode;
  level: number;
  selectedPath: string | null;
  onSelect: (folder: FolderNode) => void;
}) {
  const selected = selectedPath === node.path;
  const { darkMode } = useTheme();
  return (
    <View>
      <Pressable
        onPress={() => onSelect(node)}
        style={[
          styles.folderRow,
          selected && styles.folderRowSelected,
          darkMode && styles.folderRowDark,
          selected && darkMode && styles.folderRowSelectedDark,
          { paddingLeft: 12 + level * 18 },
        ]}
      >
        <Text style={[styles.folderIcon, darkMode && styles.subtleTextDark]}>{node.children?.length ? "▾" : "•"}</Text>
        <View style={styles.flex}>
          <Text style={[styles.folderName, darkMode && styles.textDark]}>{node.name}</Text>
          <Text style={[styles.folderPath, darkMode && styles.subtleTextDark]}>{node.path}</Text>
        </View>
      </Pressable>
      {node.children?.map((child) => (
        <FolderTreeRow
          key={child.id}
          node={child}
          level={level + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </View>
  );
}

function PrimaryButton({
  title,
  disabled,
  onPress,
  secondary,
}: {
  title: string;
  disabled: boolean;
  onPress: () => void;
  secondary?: boolean;
}) {
  const { darkMode } = useTheme();
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.primaryButton,
        secondary && styles.secondaryButton,
        secondary && darkMode && styles.secondaryButtonDark,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.primaryButtonText, secondary && styles.secondaryButtonText, secondary && darkMode && styles.textDark]}>{title}</Text>
    </Pressable>
  );
}

function StatusBadge({ value }: { value: string }) {
  const { darkMode } = useTheme();
  return (
    <View style={[styles.badge, darkMode && styles.badgeDark]}>
      <Text style={[styles.badgeText, darkMode && styles.badgeTextDark]}>{value.replace(/_/g, " ")}</Text>
    </View>
  );
}

function screenLabel(screen: Screen) {
  switch (screen) {
    case "login":
      return "Google login and remote control authorization";
    case "hosts":
      return "Choose a Codex host";
    case "projects":
      return "Projects and chats";
    case "chat":
      return "Messages and approvals";
  }
}

function topTitle(screen: Screen) {
  switch (screen) {
    case "login":
      return "Codex Remote";
    case "hosts":
      return "Hosts";
    case "projects":
      return "Projects";
    case "chat":
      return "Chat";
  }
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f8fbff" },
  safeDark: { backgroundColor: "#0b1120" },
  gradient: { flex: 1 },
  webGradient: {
    backgroundImage: "linear-gradient(135deg, #f8fbff 0%, #e8f1ff 46%, #f8f4ff 100%)",
  } as object,
  webGradientDark: {
    backgroundImage: "linear-gradient(135deg, #0b1120 0%, #101827 52%, #18122b 100%)",
  } as object,
  flex: { flex: 1 },
  shell: { flex: 1, width: "100%", maxWidth: 840, alignSelf: "center" },
  topBar: {
    alignItems: "center",
    borderBottomColor: "#d0d7de",
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 18,
  },
  topBarDark: { borderBottomColor: "#30363d" },
  titleRow: { alignItems: "center", flex: 1, flexDirection: "row", gap: 10 },
  backIconButton: {
    alignItems: "center",
    borderColor: "#d0d7de",
    borderRadius: 999,
    borderWidth: 1,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  backIcon: { color: "#24292f", fontSize: 32, fontWeight: "600", lineHeight: 34 },
  topActions: { alignItems: "center", flexDirection: "row", gap: 10 },
  themeToggle: {
    alignItems: "center",
    borderColor: "#8c959f",
    borderRadius: 999,
    borderWidth: 1,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  themeToggleDark: { borderColor: "#484f58", backgroundColor: "rgba(255,255,255,0.04)" },
  themeToggleText: { color: "#24292f", fontSize: 20, fontWeight: "800", lineHeight: 23 },
  title: { color: "#111827", fontSize: 28, fontWeight: "700" },
  subtitle: { color: "#57606a", fontSize: 14, marginTop: 2 },
  content: { gap: 14, padding: 18, paddingBottom: 34 },
  hero: { backgroundColor: "#ffffff", borderColor: "#d0d7de", borderRadius: 8, borderWidth: 1, gap: 10, padding: 16 },
  surfaceDark: { backgroundColor: "rgba(22, 27, 34, 0.92)", borderColor: "#30363d" },
  textDark: { color: "#f0f6fc" },
  subtleTextDark: { color: "#8b949e" },
  heroTitle: { color: "#111827", fontSize: 22, fontWeight: "700" },
  bodyText: { color: "#57606a", fontSize: 15, lineHeight: 21 },
  field: { gap: 6 },
  fieldLabel: { color: "#24292f", fontSize: 13, fontWeight: "700" },
  fieldInput: {
    backgroundColor: "#ffffff",
    borderColor: "#d0d7de",
    borderRadius: 8,
    borderWidth: 1,
    color: "#111827",
    fontSize: 14,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  primaryButton: { alignItems: "center", backgroundColor: "#1f6feb", borderRadius: 8, minHeight: 48, justifyContent: "center" },
  secondaryButton: { backgroundColor: "#ffffff", borderColor: "#8c959f", borderWidth: 1 },
  secondaryButtonDark: { backgroundColor: "rgba(22, 27, 34, 0.7)", borderColor: "#484f58" },
  primaryButtonText: { color: "#ffffff", fontSize: 16, fontWeight: "700" },
  secondaryButtonText: { color: "#24292f" },
  disabled: { opacity: 0.45 },
  error: { backgroundColor: "#ffebe9", color: "#8c1d18", margin: 12, padding: 10, borderRadius: 8 },
  rowBetween: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", gap: 12 },
  smallButton: { borderColor: "#8c959f", borderRadius: 7, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  smallButtonText: { color: "#24292f", fontWeight: "700" },
  iconButton: {
    alignItems: "center",
    backgroundColor: "#1f6feb",
    borderRadius: 999,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  plusIcon: { color: "#ffffff", fontSize: 28, fontWeight: "500", lineHeight: 32 },
  projectPlusButton: {
    alignItems: "center",
    borderColor: "#8c959f",
    borderRadius: 999,
    borderWidth: 1,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  iconButtonDark: { borderColor: "#484f58", backgroundColor: "rgba(255,255,255,0.04)" },
  projectPlusText: { color: "#24292f", fontSize: 22, fontWeight: "600", lineHeight: 25 },
  sectionTitle: { color: "#24292f", fontSize: 20, fontWeight: "700" },
  card: { backgroundColor: "#ffffff", borderColor: "#d0d7de", borderRadius: 8, borderWidth: 1, gap: 8, padding: 14 },
  cardTitle: { color: "#111827", fontSize: 17, fontWeight: "700" },
  meta: { color: "#57606a", fontSize: 13 },
  badge: { backgroundColor: "#eef2ff", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  badgeText: { color: "#3730a3", fontSize: 12, fontWeight: "700", textTransform: "capitalize" },
  badgeDark: { backgroundColor: "#1f2937" },
  badgeTextDark: { color: "#c7d2fe" },
  chatList: { gap: 8, marginTop: 8 },
  chatRow: { alignItems: "center", backgroundColor: "#f6f8fa", borderRadius: 8, flexDirection: "row", gap: 10, padding: 12 },
  chatRowDark: { backgroundColor: "rgba(33, 38, 45, 0.86)" },
  chatTitle: { color: "#24292f", fontSize: 15, fontWeight: "600" },
  chatScreen: { flex: 1 },
  chatHeader: {
    alignItems: "center",
    borderBottomColor: "#d0d7de",
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 10,
    padding: 12,
  },
  chatBackButton: {
    alignItems: "center",
    borderColor: "#d0d7de",
    borderRadius: 999,
    borderWidth: 1,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  chatBackIcon: { color: "#24292f", fontSize: 24, fontWeight: "600", lineHeight: 25 },
  messages: { gap: 10, padding: 16, paddingBottom: 24 },
  message: { borderRadius: 8, maxWidth: "92%", padding: 12 },
  user: { alignSelf: "flex-end", backgroundColor: "#dbeafe" },
  assistant: { alignSelf: "flex-start", backgroundColor: "#ffffff", borderColor: "#d0d7de", borderWidth: 1 },
  assistantDark: { backgroundColor: "rgba(22, 27, 34, 0.92)", borderColor: "#30363d" },
  system: { alignSelf: "center", backgroundColor: "#fff8c5" },
  messageRole: { color: "#57606a", fontSize: 11, fontWeight: "800", marginBottom: 4, textTransform: "uppercase" },
  messageText: { color: "#24292f", fontSize: 15, lineHeight: 21 },
  approvalCard: { backgroundColor: "#fff8c5", borderColor: "#d4a72c", borderRadius: 8, borderWidth: 1, gap: 10, padding: 12 },
  approvalTitle: { color: "#24292f", fontSize: 15, fontWeight: "700" },
  command: { color: "#24292f", fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }), fontSize: 13 },
  reviewText: { color: "#1f6feb", fontSize: 13, fontWeight: "800" },
  approveButton: { backgroundColor: "#1f6feb", borderRadius: 7, paddingHorizontal: 14, paddingVertical: 9 },
  approveText: { color: "#ffffff", fontWeight: "800" },
  composer: { borderTopColor: "#d0d7de", borderTopWidth: StyleSheet.hairlineWidth, flexDirection: "row", gap: 10, padding: 12 },
  composerInput: { backgroundColor: "#ffffff", borderColor: "#d0d7de", borderRadius: 8, borderWidth: 1, flex: 1, maxHeight: 110, minHeight: 44, padding: 10 },
  inputDark: { backgroundColor: "#0d1117", borderColor: "#30363d", color: "#f0f6fc" },
  sendButton: { alignItems: "center", alignSelf: "flex-end", backgroundColor: "#1f6feb", borderRadius: 8, minHeight: 44, justifyContent: "center", paddingHorizontal: 16 },
  sendText: { color: "#ffffff", fontWeight: "800" },
  modalOverlay: {
    alignItems: "center",
    backgroundColor: "rgba(15, 23, 42, 0.68)",
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  modalCard: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    gap: 18,
    maxHeight: "82%",
    maxWidth: 680,
    minHeight: 360,
    padding: 24,
    width: "100%",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.24,
    shadowRadius: 34,
  },
  modalCardDark: { backgroundColor: "#161b22", borderColor: "#30363d" },
  projectModalCard: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    gap: 16,
    maxHeight: "86%",
    maxWidth: 760,
    minHeight: 520,
    padding: 24,
    width: "100%",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.24,
    shadowRadius: 34,
  },
  modalTitle: { color: "#111827", fontSize: 26, fontWeight: "800" },
  modalCommandBox: {
    backgroundColor: "#f6f8fa",
    borderColor: "#d0d7de",
    borderRadius: 8,
    borderWidth: 1,
    gap: 14,
    padding: 16,
  },
  commandBoxDark: { backgroundColor: "#0d1117", borderColor: "#30363d" },
  modalActions: { flexDirection: "row", gap: 12, justifyContent: "flex-end", marginTop: "auto" },
  modalGhostButton: { borderColor: "#8c959f", borderRadius: 8, borderWidth: 1, minWidth: 92, paddingHorizontal: 16, paddingVertical: 12 },
  modalGhostText: { color: "#24292f", fontWeight: "800" },
  modalDenyButton: { alignItems: "center", backgroundColor: "#ffebe9", borderRadius: 8, minWidth: 92, paddingHorizontal: 16, paddingVertical: 12 },
  modalDenyText: { color: "#8c1d18", fontWeight: "800" },
  modalAcceptButton: { alignItems: "center", backgroundColor: "#1f6feb", borderRadius: 8, minWidth: 104, paddingHorizontal: 16, paddingVertical: 12 },
  modalAcceptText: { color: "#ffffff", fontWeight: "800" },
  folderTree: {
    backgroundColor: "#f6f8fa",
    borderColor: "#d0d7de",
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    minHeight: 260,
  },
  folderTreeContent: { paddingVertical: 6 },
  folderRow: { alignItems: "center", flexDirection: "row", gap: 8, minHeight: 48, paddingRight: 12 },
  folderRowSelected: { backgroundColor: "#dbeafe" },
  folderRowDark: { backgroundColor: "transparent" },
  folderRowSelectedDark: { backgroundColor: "#1f3a5f" },
  folderIcon: { color: "#57606a", fontSize: 15, width: 16 },
  folderName: { color: "#24292f", fontSize: 15, fontWeight: "700" },
  folderPath: { color: "#57606a", fontSize: 12, marginTop: 2 },
  selectedFolderBox: {
    backgroundColor: "#ffffff",
    borderColor: "#d0d7de",
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
    padding: 12,
  },
  selectedFolderText: { color: "#24292f", fontSize: 14, fontWeight: "700" },
});
