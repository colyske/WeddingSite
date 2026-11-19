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
  let canReviewCommittee = false;
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
    let committeeAllowed = false;
    try {
      const { team } = await api("manage", { cache: "no-store" });
      $("manage-panel").hidden = false;
      canReviewCommittee = true;
      renderManagement(team);
      committeeAllowed = true;
    } catch (manageError) {
      try {
        const { workspace } = await api("workspace", { cache: "no-store" });
        $("helper-panel").hidden = false;
        renderWorkspace(workspace);
        $("back-link").href = "/dashboard.html";
        committeeAllowed = Array.isArray(workspace.roles) && workspace.roles.includes("coordinator");
      } catch (workspaceError) {
        notice(workspaceError.message || manageError.message || "You do not have access to this wedding team.", true);
        return;
      }
    }
    if (committeeAllowed) {
      $("committee-panel").hidden = false;
      try {
        await loadCommittee();
      } catch (error) {
        $("committee-records").textContent = "Could not load committee records. Reload the page to try again.";
        notice(error.message || "Could not load committee records.", true);
        return;
      }
    }
    notice("");
  }

  async function loadCommittee() {
    const { records } = await api("committee-list", { cache: "no-store" });
    $("committee-records").innerHTML = records.length ? records.map(record => `
      <article class="card">
        <h4>${WS.esc(record.committee)} · ${WS.esc(record.meeting_date)}</h4>
        <p><strong>${WS.esc(record.category)}</strong> · ${WS.esc(record.notes)}</p>
        ${record.decision ? `<p><strong>Decision:</strong> ${WS.esc(record.decision)}</p>` : ""}
        ${record.action_owner || record.due_date ? `<p><strong>Action:</strong> ${WS.esc(record.action_owner || "Unassigned")} · ${WS.esc(record.due_date || "No due date")} · ${record.task_done ? "Done" : "Open"}
          <button type="button" class="ghost" data-task="${WS.esc(record.id)}" data-done="${record.task_done ? "false" : "true"}">${record.task_done ? "Reopen" : "Mark done"}</button></p>` : ""}
        ${record.suggestion ? `<p><strong>Guest-facing suggestion (${WS.esc(record.review_status)}):</strong> ${WS.esc(record.suggestion)}</p>
          ${canReviewCommittee && record.review_status === "approved" ? `<label>Approved wording to copy<textarea readonly rows="3" data-approved-wording>${WS.esc(record.suggestion)}</textarea></label>
          <button type="button" class="ghost" data-copy-wording>Copy wording</button>
          <a class="btn ghost" href="/wedding.html?id=${encodeURIComponent(weddingId)}">Open wedding editor</a>
          <p class="fine">Paste into the appropriate field and save only when ready. Saving changes to a published wedding can update the guest site immediately.</p>` : ""}
          ${canReviewCommittee && record.review_status === "pending" ? `<button type="button" class="ghost" data-review="${WS.esc(record.id)}" data-status="approved">Approve wording</button> <button type="button" class="ghost" data-review="${WS.esc(record.id)}" data-status="returned">Return for changes</button>` : ""}` : ""}
      </article>`).join("") : "No committee records yet.";
  }

  $("committee-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      await api("committee-create", { method: "POST", body: JSON.stringify({ weddingId, ...values }) });
      form.reset();
      await loadCommittee();
      notice("Private committee record saved. Suggestions are not published.");
    } catch (error) {
      notice(error.message || "Could not save committee record.", true);
    } finally {
      button.disabled = false;
    }
  });

  $("committee-records").addEventListener("click", async event => {
    const copyButton = event.target.closest("button[data-copy-wording]");
    if (copyButton) {
      const wording = copyButton.closest("article").querySelector("[data-approved-wording]");
      try {
        await navigator.clipboard.writeText(wording.value);
        notice("Approved wording copied. Paste it into the wedding editor when ready.");
      } catch {
        wording.focus();
        wording.select();
        notice("Select and copy the approved wording, then paste it into the wedding editor.");
      }
      return;
    }
    const button = event.target.closest("button[data-task], button[data-review]");
    if (!button) return;
    button.disabled = true;
    try {
      const isReview = !!button.dataset.review;
      await api(isReview ? "committee-review" : "committee-task", {
        method: "POST",
        body: JSON.stringify({ weddingId, recordId: button.dataset.review || button.dataset.task,
          ...(isReview ? { status: button.dataset.status } : { done: button.dataset.done === "true" }) })
      });
      await loadCommittee();
      notice(isReview ? "Review saved. The guest site has not changed." : "Task updated.");
    } catch (error) {
      notice(error.message || "Could not update committee record.", true);
      button.disabled = false;
    }
  });

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
