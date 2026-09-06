import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { phaseProviderReadiness } from "@/lib/operations/phase-provider-readiness";
import { PhaseProviderNotice } from "./phase-provider-notice";

const readiness = phaseProviderReadiness({ SETTERFI_PHASE4_LIVE: "true", SETTERFI_PHASE5_LIVE: "true" });

describe("provider setup notice", () => {
  it("names the unavailable action on its coach surface without configuration internals", () => {
    render(<PhaseProviderNotice path="/coach/inbox" readiness={readiness} />);
    expect(screen.getByLabelText("Provider setup required")).toHaveTextContent("Instagram and Messenger actions: provider setup is incomplete");
    expect(screen.queryByText(/SETTERFI_PHASE4_LIVE/)).toBeNull();
    expect(screen.queryByText(/Automatic workspace provisioning/)).toBeNull();
  });
  it("lists all disagreements and exact missing names on System", () => {
    render(<PhaseProviderNotice path="/admin/system" readiness={readiness} technical />);
    expect(screen.getByLabelText("Provider setup required")).toHaveTextContent("GHL_SNAPSHOT_ID");
    expect(screen.getByLabelText("Provider setup required")).toHaveTextContent("SETTERFI_PHASE4_LIVE is on");
  });
  it("does not add a warning to an unrelated or fully configured screen", () => {
    const { rerender } = render(<PhaseProviderNotice path="/coach/help" readiness={readiness} />);
    expect(screen.queryByLabelText("Provider setup required")).toBeNull();
    rerender(<PhaseProviderNotice path="/admin/system" readiness={phaseProviderReadiness({})} />);
    expect(screen.queryByLabelText("Provider setup required")).toBeNull();
  });
});
