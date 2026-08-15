import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TriStateToggle } from "../src/components/TriStateToggle.js";

afterEach(cleanup);

describe("TriStateToggle", () => {
  it("cycles allow -> disallow -> inherit -> allow", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TriStateToggle value="inherit" onChange={onChange} label="llama3 for alice" />,
    );
    const button = screen.getByRole("button", { name: "toggle llama3 for alice" });
    fireEvent.click(button);
    expect(onChange).toHaveBeenLastCalledWith("allow");
    rerender(<TriStateToggle value="allow" onChange={onChange} label="llama3 for alice" />);
    fireEvent.click(button);
    expect(onChange).toHaveBeenLastCalledWith("disallow");
    rerender(<TriStateToggle value="disallow" onChange={onChange} label="llama3 for alice" />);
    fireEvent.click(button);
    expect(onChange).toHaveBeenLastCalledWith("inherit");
  });

  it("renders the current state as text and a state class", () => {
    render(<TriStateToggle value="disallow" onChange={() => undefined} label="m for k" />);
    const button = screen.getByRole("button", { name: "toggle m for k" });
    expect(button.textContent).toBe("disallow");
    expect(button.className).toContain("tristate-disallow");
  });
});
