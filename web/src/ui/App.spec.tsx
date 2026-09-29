import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App.js";

describe("App state routing", () => {
  it("shows the nickname sheet for a room link before joining", async () => {
    const join = vi.fn();
    render(
      <App
        route={{ kind: "room", roomId: "room-1", token: "secret" }}
        roomName="Payment Debug"
        state="nickname"
        createRoom={vi.fn()}
        navigate={vi.fn()}
        join={join}
      />,
    );

    expect(screen.getByRole("heading", { name: "Payment Debug" })).toBeVisible();
    await userEvent.type(screen.getByRole("textbox", { name: "Nickname" }), "Donghyeon");
    await userEvent.click(screen.getByRole("button", { name: "Join room" }));
    expect(join).toHaveBeenCalledWith("room-1", "Donghyeon");
  });

  it.each([
    ["joining", "Joining Payment Debug…"],
    ["restoring", "Restoring terminals and output…"],
  ] as const)("announces the %s state", (state, message) => {
    render(
      <App
        route={{ kind: "room", roomId: "room-1", token: "secret" }}
        roomName="Payment Debug"
        state={state}
        createRoom={vi.fn()}
        navigate={vi.fn()}
        join={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(message);
  });
});
