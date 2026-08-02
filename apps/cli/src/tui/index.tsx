import React from "react";
import { render } from "ink";
import { DhowTui } from "./ui.js";

export function runTui({ serverUrl }: { serverUrl?: string }) {
    const baseUrl = serverUrl ?? process.env.DHOWX_SERVER_URL ?? "http://127.0.0.1:3000";
    render(<DhowTui serverUrl={baseUrl} />);
}
