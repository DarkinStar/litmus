// Builds the ONE batch of questions sent per vacancy. §5.
//
// Design rules being obeyed here:
//   §5.1  state = extracted fields only, never raw page HTML
//   §5.2  two atomic `choice` questions per harvested candidate line
//   §5.4  every question is one narrow judgment; combining happens in scoring.js
//
// Questions are written in English (§3: English is strongest) while the
// vacancy text stays Russian as-is.

import { experienceFit, workFormatFit } from './hhvocab.js';

/**
 * The line taxonomy. A binary "is this a requirement?" could not separate a
 * section heading from a real requirement — headings scored mid-range and
 * survived any threshold, while genuine requirements sometimes fell below it.
 * Classification was never a yes/no judgment, so it gets a `choice`.
 * The satisfaction judgment stays a separate question (§5.4).
 */
export const REQ_KINDS = {
  hard_requirement:
    'A skill, knowledge or ability the candidate must already have. Only if the line itself states the requirement — not if it merely announces that requirements follow.',
  nice_to_have:
    'An advantage or bonus that is explicitly optional ("будет плюсом", "will be a plus", "желательно")',
  eligibility:
    'A condition of status, availability or equipment rather than a skill: course year, student status, hours per week, start date, citizenship, security clearance, required device or internet speed',
  soft_skill:
    'A personal or interpersonal quality that cannot be verified from a CV: communication, teamwork, attention to detail, responsibility, eagerness to learn',
  heading:
    'A section label, intro, call to action, or sentence that merely INTRODUCES the lines that follow — for example "Требования:", "Будет плюсом, если вы", "Откликайтесь, если", "Мы ожидаем". Classify as heading even when it has no colon and even when it names skills in passing.',
  duty:
    'A task the person would perform on the job, not a prerequisite for getting it',
  other:
    'A benefit, salary or condition of employment, company description, process note, or anything else'
};

/** Kinds that appear in the checklist at all. */
export const SHOWN_KINDS = ['hard_requirement', 'nice_to_have', 'eligibility', 'soft_skill'];
/** Kinds that can contribute to the score. Soft skills are informational only. */
export const SCORABLE_KINDS = ['hard_requirement', 'nice_to_have'];

/**
 * Satisfaction. A plain yes/no could not distinguish "the candidate lacks this"
 * from "the profile never mentions it" — both collapsed to a low probability,
 * so unmentioned skills rendered as failures. `not_addressed` separates them.
 *
 * `satisfied` demands EXPLICIT evidence: the model was inferring skills that
 * were nowhere in the profile (a "second programming language" scored 98%
 * against a profile naming only one).
 */
export const FIT_OPTIONS = {
  satisfied:
    'The profile EXPLICITLY states something that satisfies this. Do not infer, assume, or credit skills that are merely plausible for someone with this background — the evidence must be present in the profile text.',
  partial:
    'The profile explicitly states something that partly satisfies this, or satisfies some but not all parts of it',
  not_addressed:
    'The profile is silent on this. It neither states nor contradicts it, so there is no evidence to judge either way.',
  not_satisfied:
    'The profile addresses this and demonstrably falls short of it'
};

/** Ordered level descriptions -> index maps to 0/25/50/75/100 in scoring.js */
export const SUB_QUESTIONS = {
  experience: {
    instructions:
      "How does the candidate's depth of work experience compare with the experience this vacancy requires (see vacancy.experience)?",
    criteria: [
      'Far below what the vacancy requires',
      'Noticeably below what the vacancy requires',
      'Roughly at the level the vacancy requires',
      'Comfortably meets what the vacancy requires',
      'Clearly exceeds what the vacancy requires'
    ]
  },
  domain: {
    instructions:
      "Considering the DUTIES AND TASKS described in vacancy.description as well as the job title, how well does this role match the positions the candidate is targeting?",
    criteria: [
      'A different role in an unrelated domain',
      'Loosely related to the target role',
      'Partly overlapping with the target role',
      'Closely matching the target role',
      'Exactly the role the candidate is targeting'
    ]
  },
  location: {
    instructions:
      "How compatible are the vacancy's location and work format with the candidate's stated preferences and city?",
    criteria: [
      "Incompatible with the candidate's preferences",
      'Compatible only with significant compromise',
      'Partly compatible',
      'Mostly compatible',
      "Fully compatible with the candidate's preferences"
    ]
  },
  salary: {
    instructions:
      "How does the pay stated in this vacancy compare with the candidate's stated minimum salary?",
    criteria: [
      "Far below the candidate's minimum",
      "Below the candidate's minimum",
      "At or around the candidate's minimum",
      "Comfortably above the candidate's minimum",
      "Well above the candidate's minimum"
    ]
  }
};

/**
 * Shown next to the fit gauge, never folded into it. Answers a different
 * question from the formal checklist: "have you actually done this work?",
 * regardless of whether you clear the stated bar. Catches the
 * weak-on-paper / strong-in-practice case that a formal score buries.
 */
export const TASK_AFFINITY = {
  instructions:
    'Ignore the formal requirements, years of experience and formal education entirely. Considering ONLY the day-to-day tasks and responsibilities this vacancy describes, how much of that work has the candidate demonstrably already done, in jobs, projects or study?',
  criteria: [
    'Has done none of this work',
    'Has done a small part of this work',
    'Has done roughly half of this work',
    'Has done most of this work',
    'Has done essentially all of this work'
  ]
};

/** §6.4 red flags. Shown only when triggered. */
export const FLAG_QUESTIONS = {
  unpaid_test: {
    label: 'Unpaid test task',
    instructions: 'This vacancy requires an unpaid test assignment from applicants.',
    criteria: {
      true: 'A test task, trial assignment or trial period is required and is not paid',
      false: 'No test task is mentioned, or it is paid'
    }
  },
  gray_salary: {
    label: 'Possible "gray" salary',
    instructions: 'This vacancy implies unofficial, partly undeclared or cash-in-hand pay.',
    criteria: {
      true: 'Pay is described as informal, cash, or partly unofficial',
      false: 'Pay appears fully official, or nothing suggests otherwise'
    }
  },
  vague: {
    label: 'Vague description',
    instructions: 'The description is vague or nearly empty about what the work actually is.',
    criteria: {
      true: 'The actual duties and stack are not meaningfully described',
      false: 'The duties and expectations are described concretely'
    }
  },
  agency: {
    label: 'Recruiting agency, not direct employer',
    instructions: 'This posting comes from a recruiting agency or intermediary rather than the direct employer.',
    criteria: {
      true: 'The poster is an agency, staffing firm or intermediary',
      false: 'The poster appears to be the employer itself'
    }
  },
  fake_internship: {
    label: 'Unpaid work framed as internship',
    instructions: 'This vacancy is framed as an internship but appears to be unpaid work.',
    criteria: {
      true: 'Described as internship or practice with no pay for real work',
      false: 'Not an internship, or the internship is paid'
    }
  },
  inflated: {
    label: 'Requirements inflated for the level',
    instructions: 'The requirements are unrealistically demanding for the experience level the vacancy states.',
    criteria: {
      true: 'The demands clearly exceed the stated seniority or pay',
      false: 'The demands are proportionate to the stated level'
    }
  },
  // The structured field and the prose disagreeing is a concrete, checkable
  // problem, not a vague low score.
  format_contradiction: {
    label: 'Stated work format contradicts the description',
    instructions:
      'The work format in the structured field (vacancy.workFormat) contradicts what the description text says about where the work happens.',
    criteria: {
      true: 'The field says one thing (e.g. remote) and the description clearly implies another (e.g. daily office presence)',
      false: 'The field and the description agree, or the description says nothing about location'
    }
  },
  restricted_access: {
    label: 'Citizenship or security clearance required',
    instructions:
      'This vacancy requires citizenship, residency, a security clearance, or access to a closed perimeter.',
    criteria: {
      true: 'Specific citizenship, clearance, background check or closed-perimeter access is required',
      false: 'No such restriction is mentioned'
    }
  }
};

/** §6.4 dealbreakers, derived from preferences. Cap the overall score. */
export const DEALBREAKER_QUESTIONS = {
  format: {
    label: 'Work format conflicts with your preference',
    instructions: "The vacancy's work format conflicts with the work format the candidate requires.",
    criteria: {
      true: 'The required format is one the candidate has ruled out',
      false: 'The format is acceptable to the candidate'
    }
  },
  relocation: {
    label: 'Requires relocation you ruled out',
    instructions: 'This vacancy requires relocation that the candidate has ruled out.',
    criteria: {
      true: 'Relocation is required and the candidate will not relocate',
      false: 'No relocation required, or the candidate accepts it'
    }
  },
  salary: {
    label: 'Pay below your minimum',
    instructions: "The pay stated in this vacancy is below the candidate's stated minimum salary.",
    criteria: {
      true: 'The stated pay is below the minimum the candidate requires',
      false: 'The stated pay meets the minimum, or no pay is stated'
    }
  },
  level: {
    label: 'Seniority far from your target',
    instructions: "The vacancy's seniority level is far away from the level the candidate is targeting.",
    criteria: {
      true: 'The level is far above or far below the target level',
      false: 'The level is close to what the candidate targets'
    }
  },
  employment: {
    label: 'Employment type conflicts with your preference',
    instructions: "The vacancy's employment type conflicts with the candidate's stated preference.",
    criteria: {
      true: 'The employment type is one the candidate has ruled out',
      false: 'The employment type is acceptable'
    }
  }
};

/**
 * §5.1 — the state object. Extracted FIELDS only.
 * Raw description HTML is deliberately excluded; plain text only.
 */
export function buildState(vacancy, profile, prefs) {
  return {
    vacancy: {
      title: vacancy.title,
      company: vacancy.company,
      location: vacancy.location,
      salary: vacancy.salary,            // { min, max, currency, gross, raw } | null
      experience: vacancy.experience,    // raw label string, locale-agnostic passthrough
      workFormat: vacancy.workFormat,
      employment: vacancy.employment,
      schedule: vacancy.schedule,
      keySkills: vacancy.keySkills,
      description: vacancy.descriptionText
    },
    candidate: {
      desiredPositions: profile.desiredPositions,
      city: profile.city,
      skills: profile.skills,
      experience: profile.experience,
      education: profile.education,
      projects: profile.projects,
      languages: profile.languages,
      // Availability / eligibility, so `eligibility` lines have something to
      // be judged against instead of returning a blind mid-range probability.
      status: profile.status || undefined,
      studyYear: profile.studyYear || undefined,
      hoursPerWeek: profile.hoursPerWeek || undefined,
      earliestStart: profile.earliestStart || undefined,
      workAuthorization: profile.workAuthorization || undefined,
      resumeText: profile.resumeText || undefined
    },
    preferences: {
      workFormat: prefs.workFormat,
      willRelocate: prefs.relocation,
      minSalary: prefs.minSalary,
      employment: prefs.employment,
      targetLevel: prefs.targetLevel
    }
  };
}

// Each candidate line costs two `choice` questions, and every one of them
// re-sends its full criteria dictionary. That is ~350 tokens per line before
// the line's own text. With a hard 64k limit per request (§3), a long posting
// can run out of room, so trim to fit rather than letting the call 400.
const TOKENS_PER_CANDIDATE = 360;
const REQUEST_BUDGET = 48000;           // leaves headroom under the 64k ceiling
const approxTokens = (s) => Math.ceil(String(s).replace(/[Ѐ-ӿ]/g, 'xx').length / 4);

export function budgetedCandidateCap(vacancy, settings) {
  const fixed = approxTokens(JSON.stringify(vacancy.descriptionText || '')) + 6000;
  const room = Math.floor((REQUEST_BUDGET - fixed) / TOKENS_PER_CANDIDATE);
  return Math.max(10, Math.min(settings.maxCandidates, room));
}

/**
 * Build every question for one vacancy.
 * Returns { questions, reqIndex, askedSubs, computedSubs } — computedSubs are
 * sub-scores resolved deterministically in code, so the model is never asked.
 */
export function buildQuestions(vacancy, profile, prefs, settings) {
  const questions = {};
  const askedSubs = [];
  const computedSubs = {};

  // Resolve what can be resolved without the model. hh's structured fields are
  // a closed vocabulary; "not required" versus any candidate is a comparison,
  // not a judgment, and asking returned 40%.
  const expComputed = experienceFit(vacancy.experience);
  if (expComputed) computedSubs.experience = expComputed;

  const fmtComputed = workFormatFit(vacancy.workFormat, prefs.workFormat);
  if (fmtComputed) computedSubs.location = fmtComputed;

  for (const [key, q] of Object.entries(SUB_QUESTIONS)) {
    if (computedSubs[key]) continue;                   // already decided in code
    // §5.3 — no posted salary is neutral, never a penalty. Don't ask, don't weight.
    if (key === 'salary' && (!vacancy.salary || prefs.minSalary == null)) continue;
    // Nothing constrains location at all: any format AND willing to relocate.
    if (key === 'location' && prefs.workFormat === 'any' && prefs.relocation) continue;
    questions[`sub_${key}`] = { type: 'score', instructions: q.instructions, criteria: q.criteria };
    askedSubs.push(key);
  }

  questions.task_affinity = {
    type: 'score',
    instructions: TASK_AFFINITY.instructions,
    criteria: TASK_AFFINITY.criteria
  };

  for (const [key, q] of Object.entries(FLAG_QUESTIONS)) {
    questions[`flag_${key}`] = { type: 'noul', instructions: q.instructions, criteria: q.criteria };
  }

  for (const [key, q] of Object.entries(DEALBREAKER_QUESTIONS)) {
    if (key === 'salary' && prefs.minSalary == null) continue;
    if (key === 'relocation' && prefs.relocation) continue; // willing to relocate: cannot trigger
    questions[`db_${key}`] = { type: 'noul', instructions: q.instructions, criteria: q.criteria };
  }

  // §5.2 — two atomic questions per harvested line: what KIND of line it is,
  // and how well the candidate satisfies it. Both are classifications rather
  // than yes/no judgments, so both are `choice`. They stay separate questions
  // so the two judgments never contaminate each other (§5.4).
  const reqIndex = {};
  const candidates = (vacancy.requirementCandidates || [])
    .slice(0, budgetedCandidateCap(vacancy, settings));
  candidates.forEach((line, i) => {
    const base = `req_${i}`;
    reqIndex[base] = line;
    questions[`${base}_kind`] = {
      type: 'choice',
      // Judge the line on its own wording. Previously the surrounding section
      // header dragged lines into the wrong category — an eligibility line
      // under a "Требования" header was classified as a hard requirement.
      instructions: `Classify this single line from a job posting, based only on what the line itself says, ignoring which section it appeared under: "${line}"`,
      criteria: REQ_KINDS
    };
    questions[`${base}_fit`] = {
      type: 'choice',
      instructions: `How well does the candidate's profile satisfy this line: "${line}"`,
      criteria: FIT_OPTIONS
    };
  });

  return { questions, reqIndex, askedSubs, computedSubs };
}
