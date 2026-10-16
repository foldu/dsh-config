---
name: gitlab-ci
description: Conventions for .gitlab-ci.yml — the mandatory workflow rules that stop a branch with an open merge request from running two pipelines (and the pipeline sources those rules exclude), job rules, and fully qualified container images. Use when writing or reviewing .gitlab-ci.yml; for runner tags on lab.home.5kw.li use the lab-gitlab-ci skill.
---

# GitLab CI conventions

Start every `.gitlab-ci.yml` with this block, verbatim, at the top level of the file:

```yaml
workflow:
  rules:
    # The usual pair: run for a merge request, and for a branch with no merge request open.
    # Without the middle rule a branch with an open MR runs the pipeline twice.
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS
      when: never
    - if: $CI_COMMIT_BRANCH
```

The middle rule is the point: a push to a branch with an open MR otherwise creates both a branch
pipeline and an MR pipeline. First match wins, and `workflow` is evaluated before jobs.
`$CI_OPEN_MERGE_REQUESTS` is a comma-separated list — test truthiness, never equality.

**It also excludes everything else.** These rules match branch and MR pipelines only, so
scheduled, tag, web/API and triggered pipelines are not created at all. Append extra sources
*after* the third rule:

```yaml
    - if: $CI_COMMIT_TAG
    - if: $CI_PIPELINE_SOURCE == "schedule"
```

If branches are also built by triggered pipelines, guard the middle rule with
`&& $CI_PIPELINE_SOURCE == "push"` and say why in the file.

Leave the branch-versus-MR decision to `workflow`; do not repeat it in job rules.

## Container images

Name images fully qualified, registry host included: `docker.io/alpine`,
`docker.io/library/node:22`, `ghcr.io/owner/tool`. A bare `alpine` resolves through whatever
default registry the runner has configured, and the job log prints the resolved form back
(`Using Docker executor with image docker.io/alpine`) — write that.
