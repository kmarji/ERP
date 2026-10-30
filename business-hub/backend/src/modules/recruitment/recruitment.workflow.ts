import { WorkflowDefinition } from '../workflow-engine/workflow.types';

export const WF03 = 'WF-03';

// One workflow instance per application. Anything that rejects a person is a human (or explicitly configured policy)
// decision recorded with a reason; the AI interview only ever produces advice with evidence.
export const WF03_DEFINITION: WorkflowDefinition = {
  key: WF03,
  name: 'Recruitment-to-Employment',
  initial: 'RECEIVED',
  terminal: ['WITHDRAWN', 'HIRED'],
  transitions: {
    RECEIVED: { incomplete: 'INCOMPLETE', screen_pass: 'SCREENED', screen_fail: 'SCREENED_OUT', withdraw: 'WITHDRAWN' },
    INCOMPLETE: { completed: 'RECEIVED', withdraw: 'WITHDRAWN' },
    SCREENED_OUT: { confirm_reject: 'REJECTED', override: 'SCREENED', withdraw: 'WITHDRAWN' },
    SCREENED: { invite: 'INTERVIEW_INVITED', reject: 'REJECTED', withdraw: 'WITHDRAWN' },
    INTERVIEW_INVITED: { scheduled: 'INTERVIEW_SCHEDULED', needs_review: 'UNDER_REVIEW', withdraw: 'WITHDRAWN' },
    INTERVIEW_SCHEDULED: { interview_done: 'INTERVIEWED', needs_review: 'UNDER_REVIEW', reinvite: 'INTERVIEW_INVITED', withdraw: 'WITHDRAWN' },
    INTERVIEWED: { auto_advance: 'ADVANCED', needs_review: 'UNDER_REVIEW', withdraw: 'WITHDRAWN' },
    UNDER_REVIEW: { advance: 'ADVANCED', reject: 'REJECTED', reinvite: 'INTERVIEW_INVITED', withdraw: 'WITHDRAWN' },
    ADVANCED: { offer_created: 'OFFER_PENDING', reject: 'REJECTED', withdraw: 'WITHDRAWN' },
    OFFER_PENDING: { offer_accepted: 'ONBOARDING', offer_declined: 'WITHDRAWN', offer_withdrawn: 'ADVANCED' },
    ONBOARDING: { onboarding_complete: 'HIRED', withdraw: 'WITHDRAWN' },
    // A rejection is final unless an appeal is upheld by someone other than the original decider.
    REJECTED: { reopen: 'UNDER_REVIEW' },
  },
};
