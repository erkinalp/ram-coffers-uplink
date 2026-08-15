import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrivacyData } from "../src/api.js";
import { PrivacyView } from "../src/pages/Privacy.js";

afterEach(cleanup);

const base: PrivacyData = {
  name: "alice",
  rpm_limit: 60,
  tokens_per_day: null,
  stats_enabled: false,
  models: [{ model: "llama3", allowed: true, source: "default" }],
  stats: null,
  statement: "Prompts and responses are never stored or logged.",
};

describe("PrivacyView", () => {
  it("shows key details, the zero-logging statement and no stats when disabled", async () => {
    const fetcher = vi.fn().mockResolvedValue(base);
    render(<PrivacyView apiKey="k" fetchPrivacy={fetcher} />);
    await waitFor(() => screen.getByText("alice"));
    expect(screen.getByText(/never stored or logged/)).toBeDefined();
    expect(screen.getByText("llama3")).toBeDefined();
    expect(screen.getByText("60 / minute")).toBeDefined();
    expect(screen.getByText("unlimited")).toBeDefined();
    expect(screen.queryByText("Your statistics")).toBeNull();
    expect(fetcher).toHaveBeenCalledWith("k");
  });

  it("shows own aggregate rows when statistics are enabled", async () => {
    const data: PrivacyData = {
      ...base,
      stats_enabled: true,
      stats: [
        {
          key_id: 1,
          key_name: "alice",
          model: "llama3",
          hour: "2026-08-13T18",
          requests: 2,
          prompt_tokens: 10,
          completion_tokens: 20,
          errors: 0,
        },
      ],
    };
    render(<PrivacyView apiKey="k" fetchPrivacy={vi.fn().mockResolvedValue(data)} />);
    await waitFor(() => screen.getByText("Your statistics"));
    expect(screen.getByText("2026-08-13T18")).toBeDefined();
  });

  it("shows an error for a rejected key", async () => {
    render(
      <PrivacyView
        apiKey="bad"
        fetchPrivacy={vi.fn().mockRejectedValue(new Error("invalid API key"))}
      />,
    );
    await waitFor(() => screen.getByText(/invalid API key/));
  });
});
