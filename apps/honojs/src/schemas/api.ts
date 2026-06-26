export type HostItem = {
  id: string;
  env_id: string;
  kind?: string;
  display_name: string;
  host_name: string;
  online: boolean;
  busy?: boolean;
  os?: string;
  os_version?: string;
  arch?: string;
  app_server_version?: string;
  client_type?: string;
  client_version?: string;
  last_seen_at?: string;
};

export type ProjectItem = {
  id: string;
  hostId: string;
  remotePath: string;
  label: string;
  source: "global-state" | "ssh-config";
};

export type ChatItem = {
  id: string;
  title?: string;
  status?: string;
  environment_id?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
};

export type TurnItem = {
  id: string;
  type: string;
  role: string;
  input_items: unknown[];
  output_items: unknown[];
  [key: string]: unknown;
};

export type TaskResult = {
  task_id: string;
  status?: string;
  [key: string]: unknown;
};
