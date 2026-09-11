/**
 * conversation-rename — whether renaming a conversation is offered at all.
 *
 * It is not, and it never was. Both `SessionHeader` and `SessionRow` shipped an
 * inline rename that commits with
 * `PATCH /api/chat/sessions/:id { title }` — a route the server does not
 * register. `routes-chat.ts` has GET and DELETE on
 * `/api/chat/conversations/:id` and nothing else, and the client is not even
 * calling that path. So every rename 404s, the component quietly restores the
 * old title, and the only trace is a `console.warn` the user will never see.
 *
 * From the outside that is an editable-looking title that silently refuses to
 * change — a Half-Wired Code Policy violation and, worse, one the user reads as
 * "I did something wrong." `SessionHeader`'s own TODO admitted it.
 *
 * (TASK-337 / audit C2.) This card's job is only to stop the silent no-op.
 * Whether we build the PATCH endpoint or formally park the feature is **audit
 * open question 4** and a human's decision — deliberately NOT made here.
 *
 * The rename implementations are left intact behind this flag rather than
 * deleted, so answering question 4 with "build it" is this one line plus the
 * route. Answering it with "park it" is this one line plus deleting the two
 * rename blocks.
 */
export const CONVERSATION_RENAME_ENABLED = false;
