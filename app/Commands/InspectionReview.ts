import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import type { InspectionReview, InspectionReviewInput } from '../../resources/functions/drone/inspection/types'
import { createInspectionReview, parseInspectionRecording, validateInspectionReview } from '../../resources/functions/drone/inspection/evidence'
import { writeInspectionDataset } from '../../resources/functions/drone/inspection/export'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'inspection:review <recording>',
  description: 'Record an explicit operator observation tied to one source image, capture pose and asset point',
  options: {
    '--id <id>': 'Required new review identity',
    '--capture <id>': 'Required retained capture identity',
    '--reviewer <id>': 'Required operator-declared reviewer identity, not authentication',
    '--reviewed-at <time>': 'Required canonical UTC review time, for example 2026-10-18T12:00:00.000Z',
    '--decision <name>': 'Required: suspected-defect, no-defect-observed or needs-follow-up',
    '--modality <name>': 'Required: visible or thermal',
    '--x <n>': 'Required calibrated output pixel x coordinate',
    '--y <n>': 'Required calibrated output pixel y coordinate',
    '--note <text>': 'Required operator observation; no automated defect diagnosis',
    '--reviews <path>': 'Optional existing reviews.json array to validate and retain',
    '--output <directory>': 'Required new private dataset; the original recording is preserved',
  },
  async handle(options, path) {
    try {
      if (![options.id, options.capture, options.reviewer, options.reviewedAt, options.decision, options.modality, options.x, options.y, options.note, options.output].every(value => typeof value === 'string' && value.length > 0)) throw new TypeError('Specify all required review fields and --output')
      const run = parseInspectionRecording(await readMissionFile(path))
      const reviews: InspectionReview[] = []
      if (options.reviews) {
        let retained: unknown
        try { retained = JSON.parse(await readMissionFile(options.reviews)) }
        catch { throw new TypeError('Invalid retained inspection reviews JSON or file') }
        if (!Array.isArray(retained) || retained.length >= 64) throw new RangeError('Retained reviews must be an array of at most 63 records')
        for (const review of retained) reviews.push(await validateInspectionReview(run, review))
      }
      const review = await createInspectionReview(run, { id: options.id!, captureId: options.capture!, reviewerId: options.reviewer!, reviewedAt: options.reviewedAt!, decision: options.decision as InspectionReviewInput['decision'], modality: options.modality as InspectionReviewInput['modality'], pixel: [Number(options.x), Number(options.y)], note: options.note! })
      const dataset = await writeInspectionDataset(options.output!, run, [...reviews, review])
      print(JSON.stringify({ review, retainedReviews: reviews.length, dataset }, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
