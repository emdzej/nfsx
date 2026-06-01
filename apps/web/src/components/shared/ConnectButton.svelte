<script lang="ts">
  import { ConnectButton as SharedConnectButton, type ConnectionPhase } from "@emdzej/ediabasx-web-ui";
  import { connect, disconnect, connection } from "../../lib/ediabas-session.svelte";

  const phase = $derived<ConnectionPhase>(
    connection.status.kind === "connected"
      ? "connected"
      : connection.status.kind === "connecting"
        ? "connecting"
        : connection.status.kind === "error"
          ? "error"
          : "disconnected",
  );

  const message = $derived(
    connection.status.kind === "connected"
      ? `Connected · ${connection.status.portInfo}`
      : connection.status.kind === "connecting"
        ? "Connecting…"
        : connection.status.kind === "error"
          ? connection.status.message
          : "Not connected",
  );

  const errorMessage = $derived(
    connection.status.kind === "error" ? connection.status.message : undefined,
  );
</script>

<SharedConnectButton
  {phase}
  {message}
  {errorMessage}
  idleTitle="Connect to ECU via the configured interface"
  onconnect={connect}
  ondisconnect={disconnect}
/>
