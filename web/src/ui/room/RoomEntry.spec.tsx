import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CreateRoomEntry, JoinRoomEntry } from "./RoomEntry.js";

describe("RoomEntry", () => {
  it("creates a named Quick Room from the bare route", async () => {
    const createRoom = vi.fn().mockResolvedValue(undefined);
    render(<CreateRoomEntry createRoom={createRoom} />);

    expect(screen.getByRole("heading", { name: "Start a Quick Room" })).toBeVisible();
    const name = screen.getByRole("textbox", { name: "Room name" });
    expect(name).toHaveValue("Quick Room");

    await userEvent.click(screen.getByRole("button", { name: "Create room" }));
    expect(createRoom).toHaveBeenCalledWith("Quick Room");
  });

  it("keeps Join room disabled only while the nickname is invalid", async () => {
    const join = vi.fn();
    render(<JoinRoomEntry roomName="Payment Debug" initialName="" join={join} />);
    const button = screen.getByRole("button", { name: "Join room" });
    expect(button).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox", { name: "Nickname" }), "Donghyeon");
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(join).toHaveBeenCalledWith("Donghyeon");
  });
});
