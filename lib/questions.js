// Builds the ONE batch of questions sent per vacancy. §5.
//
// Design rules being obeyed here:
//   §5.1  state = extracted fields only, never raw page HTML
//   §5.2  two atomic nouls per harvested candidate line (is / fit)
//   §5.4  every question is one narrow judgment; combining happens in scoring.js
//
// Questions are written in English (§3: English is strongest) while the
// vacancy text stays Russian as-is.

/**
 * The line taxonomy. A binary "is this a requirement?" could not separate a
 * section heading from a real requirement — headings scored mid-range and
 * survived any threshold, while genuine requirements sometimes fell below it.
 * Classification was never a yes/no judgment, so it gets a `choice`.
 * The satisfaction judgment stays a separate question (§5.4).
 */
export const REQ_KINDS = {
  hard_requirement: 'Something the candidate must have, know, or be able to do',
  nice_to_have: 'An advantage or bonus, explicitly optional ("будет плюсом", "will be a plus")',
  eligibility: 'A status or availability condition rather than a skill: course year, student status, hours per week, citizenship, start date',
  heading: 'A section label or instruction introducing the lines that follow, not itself a requirement',
  duty: 'A task the person would perform on the job, not a prerequisite for getting it',
  other: 'A benefit, company description, process note, or anything else'
};

/** Kinds that appear in the checklist at all. */
export const SHOWN_KINDS = ['hard_requirement', 'nice_to_have', 'eligibility'];

/**
 * Satisfaction. A plain yes/no could not distinguish "the candidate lacks this"
 * from "the profile never mentions it" — both collapsed to a low probability,
 * so unmentioned skills rendered as failures. `not_addressed` separates them.
 */
export const FIT_OPTIONS = {
  satisfied: "The candidate's profile clearly satisfies this",
  partial: 'The profile partially satisfies this, or satisfies something adjacent to it',
  not_addressed: 'The profile simply does not mention this either way — there is no evidence to judge',
  not_satisfied: 'The profile addresses this and falls short of it'
};

/** Ordered level descriptions -> index maps to 0/25/50/75/100 in scoring.js */
export const SUB_QUESTIONS = {
  // Scoped to hh's own key-skill tags rather than the description prose, so it
  // measures something the requirement checklist does not. Asked only when the
  // posting carries tags; otherwise its weight redistributes.
  skills: {
    instructions:
      'Considering ONLY the list in vacancy.keySkills (the employer\'s own skill tags), how many of those tags does the candidate demonstrably have?',
    criteria: [
      'Almost none of the tagged skills',
      'A few of the tagged skills, major gaps remain',
      'Roughly half of the tagged skills',
      'Most of the tagged skills, with minor gaps',
      'All or nearly all of the tagged skills'
    ]
  },
  experience: {
    instructions:
      "How does the candidate's depth of work experience compare with what this vacancy expects?",
    criteria: [
      'Far below what the vacancy expects',
      'Noticeably below what the vacancy expects',
      'Roughly at the level the vacancy expects',
      'Comfortably meets what the vacancy expects',
      'Clearly exceeds what the vacancy expects'
    ]
  },
  domain: {
    instructions:
      'How well does this vacancy\'s role and domain match the positions the candidate is targeting?',
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
      "How compatible are the vacancy's location and work format with the candidate's stated preferences?",
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

/**
 * Build every question for one vacancy.
 * Returns { questions, reqIndex, askedSubs } — reqIndex maps req key -> line text
 * so scoring.js can rebuild the checklist from the flat answer map.
 */
export function buildQuestions(vacancy, profile, prefs, settings) {
  const questions = {};
  const askedSubs = [];

  for (const [key, q] of Object.entries(SUB_QUESTIONS)) {
    // §5.3 — no posted salary is neutral, never a penalty. Don't ask, don't weight.
    if (key === 'salary' && (!vacancy.salary || prefs.minSalary == null)) continue;
    // Skills is scoped to the employer's tags; with no tags there is nothing
    // to measure, so skip it and let its weight redistribute.
    if (key === 'skills' && !(vacancy.keySkills || []).length) continue;
    // Nothing constrains location at all: any format is fine AND the candidate
    // will relocate, so every vacancy is trivially compatible. Asking returns
    // a mid-range answer with low confidence — noise, not signal. With a format
    // preference, or an unwillingness to relocate, the question still bites.
    if (key === 'location' && prefs.workFormat === 'any' && prefs.relocation) continue;
    questions[`sub_${key}`] = { type: 'score', instructions: q.instructions, criteria: q.criteria };
    askedSubs.push(key);
  }

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
  const candidates = (vacancy.requirementCandidates || []).slice(0, settings.maxCandidates);
  candidates.forEach((line, i) => {
    const base = `req_${i}`;
    reqIndex[base] = line;
    questions[`${base}_kind`] = {
      type: 'choice',
      instructions: `Classify this line from a job posting: "${line}"`,
      criteria: REQ_KINDS
    };
    questions[`${base}_fit`] = {
      type: 'choice',
      instructions: `How well does the candidate's profile satisfy this line: "${line}"`,
      criteria: FIT_OPTIONS
    };
  });

  return { questions, reqIndex, askedSubs };
}
