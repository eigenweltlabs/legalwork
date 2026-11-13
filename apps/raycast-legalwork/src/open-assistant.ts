import type { LaunchProps } from "@raycast/api";
import { launch } from "./legalwork";

export default async function Command(props: LaunchProps<{ arguments: { question?: string } }>) {
  const question = props.arguments.question?.trim();
  await launch(question ? "ask" : "resume", question ? { q: question } : {});
}
