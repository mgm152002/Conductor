# UI verification fixture

Run `npx vite --config test/ui/vite.config.ts`, then open
`http://127.0.0.1:5174/test/ui/index.html?width=960&height=640#/home`.

This renders the application with synthetic IPC data. It does not execute agents
or read a real project's data. Casual conversations persist in this fixture's
browser localStorage only. Add `no-projects=1` to check project-free Chat.
Use `draft=1#/work` to begin with a new project thread.
The optional width and height fix the application surface so the minimum window
can be checked inside a larger browser.

Check the following interactions:

1. In Chat, send a message and a follow-up. Both should receive synthetic replies,
   and appear in the Chats history. No Projects, Plan, Checks or inspector appears.
2. Switch to Work. Only project threads appear in the sidebar. Open a thread,
   then start a new one. Both actions must stay in Work.
3. Enable Plan, open Sub-agents and Checks, and select the long model name.
   All options should wrap inside the composer and the send button should remain reachable.
4. Open an existing project's details inspector. At 960 pixels it should overlay the conversation,
   stay within the main surface, and close using its close button or Escape.
5. Use Left/Right or Home/End on the inspector tabs. Focus and selection should move together.
6. Switch back to Chat. Its original conversation should remain selected and show
   the follow-up, with no project tasks mixed in. New chat opens a blank conversation.
7. Reload with `no-projects=1`. Chat still works; Work prompts to add a project.

For geometry checks, the composer form, Task options container and selected
inspector panel should have `scrollWidth <= clientWidth`. The inspector's right
edge should stay at or inside the application's right edge.
