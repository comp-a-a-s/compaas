# Integration Operations Playbook

This playbook defines how to operate, diagnose, and safely roll back connector behavior in COMPaaS.

## Connectors In Scope

- GitHub
- GitLab
- Vercel
- Netlify
- Stripe
- Slack
- Telegram
- Linear
- Notion
- Jira

## Readiness Check (Before Release)

1. Open `GET /api/v1/system/readiness`.
2. Confirm `integrations.coverage.verified_connectors` matches expected rollout set.
3. Confirm no connector required for the target flow is in `status=degraded`.
4. Run connector smoke:
- verify endpoint (for each enabled connector)
- one operation endpoint (deploy/send/create/upsert/transition)
5. Confirm activity stream contains integration events for operations.

## Health Semantics

- `disconnected`: no usable credentials configured.
- `configured`: credentials/config present, not yet verified.
- `verified`: connector verify and latest operation succeeded.
- `degraded`: operation failed after previously configured state.

Each connector stores:

- `*_status`
- `*_verified_at`
- `*_last_success_at`
- `*_last_error`
- `*_consecutive_failures`

## Failure Triage

1. Open Settings and identify connector with `degraded` status.
2. Read `last_error` and `consecutive_failures`.
3. Use connector-specific retry action in Settings:
- Re-verify connector credentials
- Re-run the failed operation
4. If retries fail, pause rollout and execute rollback path below.

## Rollback Path

1. Disable affected connector by feature flag:
- `linear_connector`
- `notion_connector`
- `jira_connector`
- `gitlab_connector`
2. Keep existing stable connectors enabled.
3. Re-run readiness and confirm degraded connector is no longer required in active flow.
4. Communicate fallback path to operators:
- Delivery fallback: GitHub/local mode if GitLab is disabled
- Work-management fallback: keep task creation in-app if Linear/Jira disabled
- Documentation fallback: keep handoff in-app if Notion disabled
5. Re-enable only after root cause is fixed and verify + smoke are green.

## Progressive Rollout Guidance

1. Enable one new connector flag per environment.
2. Verify and run operation smoke.
3. Observe activity stream and readiness for one release window.
4. Continue to the next connector.

## Operator Checklist

- Readiness API green for target rollout
- Connector feature flags explicitly set
- Smoke tests passed
- Activity events visible for connector actions
- Rollback owner assigned
- User-facing guidance updated in Settings panel
