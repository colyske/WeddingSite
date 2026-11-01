(() => {
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const weddingId = params.get("weddingId") || "";
  const roleLabels = {
    checkin: "Entrance check-in",
    usher: "Usher",
    coordinator: "Committee coordinator",
    rsvp_support: "RSVP support",
    dj: "DJ playlist operator"
  };
  const notice = (message, bad = false) => {
    $("team-notice").hidden = !message;
    $("team-notice").textContent = message || "";
    $("team-notice").className = "notice" + (bad ? " bad" : "");
  };
  const api = async (action, options = {}) => {
    const response = await WS.api(`/api/team?action=${action}${weddingId ? `&weddingId=${encodeURIComponent(weddingId)}` : ""}`, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Wedding team request failed.");
    return data;
  };
  const roleName = roleLabels;
  const expiryLabel = value => value ? new Date(value).toLocaleString() : "No expiry";
  function expiryFields(mode, input) {
    return { expiryMode: mode.value, ...(mode.value === "custom" ? { grantExpiresAt: new Date(input.value).toISOString() } : {}) };
  }

  if (!weddingId) {
    notice("Wedding ID is missing.", true);
  } else if (!WS.token()) {
    location.replace(`/signin.html?next=${encodeURIComponent(`/team.html?weddingId=${weddingId}`)}`);
  } else {
    $("back-link").href = `/wedding.html?id=${encodeURIComponent(weddingId)}`;
    load();
  }

  async function load() {
    notice("Loading wedding team…");
    try {
      const { team } = await api("manage", { cache: "no-store" });
      $("manage-panel").hidden = false;
      renderManagement(team);
      notice("");
    } catch (manageError) {
      try {
        const { workspace } = await api("workspace", { cache: "no-store" });
        $("helper-panel").hidden = false;
        renderWorkspace(workspace);
        $("back-link").href = "/dashboard.html";
        notice("");
      } catch (workspaceError) {
        notice(workspaceError.message || manageError.message || "You do not have access to this wedding team.", true);
      }
    }
  }

  function renderManagement(team) {
    $("pending-invites").innerHTML = team.invites?.length
      ? `<ul>${team.invites.map(invite => `<li>${WS.esc(invite.invitee_email)} · ${WS.esc(roleName[invite.role] || invite.role)} · link expires ${WS.esc(new Date(invite.expires_at).toLocaleDateString())} · access: ${WS.esc(expiryLabel(invite.grant_expires_at))} <button type="button" class="ghost" data-revoke-invite="${WS.esc(invite.id)}">Revoke</button></li>`).join("")}</ul>`
      : "No pending invitations.";
    $("team-members").innerHTML = team.members?.length
      ? `<ul>${team.members.map(member => `<li>${WS.esc(member.display_name || "Wedding helper")} · ${WS.esc((member.roles || []).map(role => roleName[role] || role).join(", "))} <button type="button" class="ghost" data-revoke-member="${WS.esc(member.user_id)}">Revoke access</button>
        <p>${(member.grants || []).map(grant => `${WS.esc(roleName[grant.role] || grant.role)}: ${WS.esc(expiryLabel(grant.expires_at))}${grant.expires_at && new Date(grant.expires_at) <= new Date() ? " (expired)" : ""}`).join("; ")}</p>
        <form data-member-expiry="${WS.esc(member.user_id)}">
          <label>Access expiry for all this helper's roles
            <select name="expiryMode"><option value="event">After the wedding (30 days if no date)</option><option value="custom">Choose a date and time</option><option value="none">No expiry (until revoked)</option></select>
          </label>
          <label data-custom-expiry hidden>Expiry (your local time)<input name="grantExpiresAt" type="datetime-local"></label>
          <button type="submit" class="ghost">Update access expiry</button>
        </form></li>`).join("")}</ul>`
      : "No active helpers.";
  }

  function renderWorkspace(workspace) {
    const roles = Array.isArray(workspace.roles) ? workspace.roles : [];
    $("helper-roles").textContent = roles.map(role => roleName[role] || role).join(", ");
    $("checkin-tools").hidden = workspace.can_check_in !== true;
    if (Array.isArray(workspace.guests) && roles.some(role => ["usher", "coordinator"].includes(role))) {
      $("usher-tools").hidden = false;
      $("usher-roster").innerHTML = table(
        ["Guest", "Table", "RSVP", "Checked in"],
        workspace.guests.map(guest => [guest.name, guest.table_number || "Unassigned", guest.rsvp_status || "Not recorded", guest.checked_in ? "Yes" : "No"])
      );
    }
    if (Array.isArray(workspace.rsvp_support) && roles.includes("rsvp_support")) {
      $("rsvp-tools").hidden = false;
      $("rsvp-roster").innerHTML = table(
        ["Guest", "Email", "Phone", "RSVP", "Party"],
        workspace.rsvp_support.map(guest => [guest.guest_name, guest.guest_email, guest.phone || "—", guest.attendance_status, String(1 + Number(guest.plus_one_count || 0))])
      );
    }
    if (Array.isArray(workspace.playlist) && roles.includes("dj")) {
      $("dj-tools").hidden = false;
      $("dj-playlist").innerHTML = table(
        ["#", "Song", "Artist"],
        workspace.playlist.map((song, index) => [String(song.rank_position || index + 1), song.song_title, song.artist_name])
      );
    }
  }

  function table(headers, rows) {
    if (!rows.length) return "Nothing to show yet.";
    return `<table><thead><tr>${headers.map(header => `<th>${WS.esc(header)}</th>`).join("")}</tr></thead><tbody>${rows
      .map(row => `<tr>${row.map(cell => `<td>${WS.esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }

  $("invite-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = $("invite-form").querySelector("button[type=submit]");
    button.disabled = true;
    $("invite-link-box").hidden = true;
    try {
      const response = await WS.api("/api/team?action=invite", {
        method: "POST",
        body: JSON.stringify({ weddingId, role: $("invite-role").value, email: $("invite-email").value,
          ...expiryFields($("invite-expiry-mode"), $("invite-grant-expiry")) })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create an invitation.");
      $("invite-link").value = new URL(data.inviteLink, location.origin).href;
      $("invite-delivery").textContent = "Secure link created, not sent. Share it directly. It expires in 7 days.";
      $("invite-link-box").hidden = false;
      notice("Invitation link created.");
      $("invite-form").reset();
      updateInviteExpiry();
      await reloadManagement();
    } catch (error) {
      notice(error.message || "Could not create an invitation.", true);
    } finally {
      button.disabled = false;
    }
  });

  function updateInviteExpiry() {
    const custom = $("invite-expiry-mode").value === "custom";
    $("invite-expiry-label").hidden = !custom;
    $("invite-grant-expiry").hidden = !custom;
    $("invite-grant-expiry").required = custom;
  }
  $("invite-expiry-mode").addEventListener("change", updateInviteExpiry);

  $("team-members").addEventListener("change", event => {
    if (event.target.name !== "expiryMode") return;
    const form = event.target.closest("form");
    const custom = event.target.value === "custom";
    form.querySelector("[data-custom-expiry]").hidden = !custom;
    form.elements.grantExpiresAt.required = custom;
  });
  $("team-members").addEventListener("submit", async event => {
    const form = event.target.closest("[data-member-expiry]");
    if (!form) return;
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      await api("set-expiry", {
        method: "POST",
        body: JSON.stringify({ weddingId, userId: form.dataset.memberExpiry,
          ...expiryFields(form.elements.expiryMode, form.elements.grantExpiresAt) })
      });
      notice("Helper access expiry updated.");
      await reloadManagement();
    } catch (error) {
      notice(error.message || "Could not update helper access expiry.", true);
    } finally {
      button.disabled = false;
    }
  });

  $("copy-invite").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("invite-link").value);
      notice("Invite link copied.");
    } catch {
      $("invite-link").select();
      notice("Select and copy the invite link.");
    }
  });

  $("manage-panel").addEventListener("click", async event => {
    const inviteId = event.target.closest("[data-revoke-invite]")?.dataset.revokeInvite;
    const userId = event.target.closest("[data-revoke-member]")?.dataset.revokeMember;
    if (!inviteId && !userId) return;
    const action = inviteId ? "revoke-invite" : "revoke-member";
    const confirmation = inviteId ? "Revoke this invitation?" : "Revoke this helper's access?";
    if (!confirm(confirmation)) return;
    try {
      await WS.api(`/api/team?action=${action}`, {
        method: "POST",
        body: JSON.stringify({ weddingId, ...(inviteId ? { inviteId } : { userId }) })
      }).then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not revoke access.");
      });
      notice("Access revoked.");
      await reloadManagement();
    } catch (error) {
      notice(error.message || "Could not revoke access.", true);
    }
  });

  async function reloadManagement() {
    const { team } = await api("manage", { cache: "no-store" });
    renderManagement(team);
  }
})();
