import type { RequestContext, ResponseMessage } from '@vulppi/kit'

export async function GET(ctx: RequestContext): Promise<ResponseMessage> {
  const stream = ctx.fileStream('video.mp4')

  return {
    status: 200,
    body: stream,
    headers: {
      'Content-Type': 'video/mp4',
    },
  }
}