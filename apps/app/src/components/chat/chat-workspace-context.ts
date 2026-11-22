import { createContext } from "react";

export const ChatWorkspaceContext = createContext<"project" | "wiki" | "timekeeping">("project");
