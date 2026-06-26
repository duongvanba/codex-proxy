export type Session = {
  accessToken: string;
  accountId: string;
  apiBase: string;
  email: string;
  remoteControlAuthorized: boolean;
};

export type Host = {
  id: string;
  name: string;
  platform: string;
  status: "online" | "offline" | "needs_auth";
  lastSeen: string;
};

export type Project = {
  id: string;
  hostId: string;
  name: string;
  path: string;
  chats: ChatSummary[];
};

export type ChatSummary = {
  id: string;
  title: string;
  updatedAt: string;
  status: "idle" | "running" | "waiting_approval";
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
};

export type ApprovalRequest = {
  id: string;
  title: string;
  command: string;
  risk: "low" | "medium" | "high";
};

export type FolderNode = {
  id: string;
  name: string;
  path: string;
  children?: FolderNode[];
};
