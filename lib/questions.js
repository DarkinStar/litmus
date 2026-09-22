// Builds the ONE batch of questions sent per vacancy. §5.
//
// Design rules being obeyed here:
//   §5.1  state = extracted fields only, never raw page HTML
//   §5.2  two atomic nouls per harvested candidate line (is / fit)
//   §5.4  every question is one narrow judgment; combining happens in scoring.js
//
// Questions are written in English (§3: English is strongest) while the
// vacancy text stays Russian as-is.

/** Ordered level descriptions -> index maps to 0/25/50/75/100 in scoring.js */
export const SUB_QUESTIONS = {
  skills: {
    instructions:
      "How well do the candidate's skills match the skills this vacancy requires?",
    criteria: [
      'The candidate has almost none of the required skills',
      'The candidate has a few required skills but major gaps remain',
      'The candidate has roughly half of the required skills',
      'The candidate has most of the required skills, with minor gaps',
      'The candidate has all or nearly all of the required skills'
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

  // §5.2 — two atomic nouls per harvested candidate line.
  const reqIndex = {};
  const candidates = (vacancy.requirementCandidates || []).slice(0, settings.maxCandidates);
  candidates.forEach((line, i) => {
    const base = `req_${i}`;
    reqIndex[base] = line;
    questions[`${base}_is`] = {
      type: 'noul',
      instructions: `This text states a requirement or expectation placed on the candidate: "${line}"`,
      criteria: {
        true: 'It states something the candidate must have, know, or be able to do',
        false: 'It is a duty, a benefit, a company description, or other non-requirement text'
      }
    };
    questions[`${base}_fit`] = {
      type: 'noul',
      instructions: `The candidate's profile satisfies this requirement: "${line}"`,
      criteria: {
        true: "The candidate's background clearly satisfies it",
        false: "The candidate's background does not satisfy it"
      }
    };
  });

  return { questions, reqIndex, askedSubs };
}
