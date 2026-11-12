<script setup lang="ts">
// The first-run safety points, shared by the one-time note (SafetyNote.vue) and the setup's last step.
</script>

<template>
  <ul class="list-disc space-y-2 pl-5 text-[13.5px] leading-relaxed text-ink-soft marker:text-faint">
    <li>Every session is the real Claude Code, Codex or agy CLI. You pick its permission mode when you start it, and Settings has the default ("Start new sessions in auto mode", off by default):</li>
    <li class="list-none -ml-5 pl-5"><span class="font-medium text-ink">Ask</span> (auto mode off): the tool's normal approval prompts, and Overvibe shows each one so you can allow or refuse it.</li>
    <li class="list-none -ml-5 pl-5"><span class="font-medium text-ink">Auto</span>: each tool's auto mode runs commands and edits files without stopping to ask, with its own safety checks. Codex also gets network access and your work root writable.</li>
    <li>An agent can run shell commands and change files in the folders you open. Open only repos you trust: a hostile README or script can give it instructions.</li>
    <li>The server listens on 127.0.0.1 and nowhere else, and every request needs your token. The login link contains that token, so keep it to yourself.</li>
  </ul>
</template>
