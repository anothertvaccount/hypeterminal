import { createFileRoute } from "@tanstack/react-router";
import { BuilderFeeTool } from "@/components/dev/builder-fee-tool";

export const Route = createFileRoute("/dev-builder-fees")({
	ssr: false,
	component: BuilderFeeTool,
});
