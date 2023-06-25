import { AbstractTool } from './AbstractTool.js'
import fetch, { File, FormData } from 'node-fetch'
import { Config } from '../config.js'
export class ImageCaptionTool extends AbstractTool {
  name = 'imageCaption'

  parameters = {
    properties: {
      imgUrl: {
        type: 'string',
        description: 'the url of the image.'
      },
      qq: {
        type: 'string',
        description: 'if the picture is avatar of a user, input his qq number'
      },
      question: {
        type: 'string',
        description: 'if you want to ask something about this picture, write your question in English here. If you just want to know what\'s in the photo, leave it blank'
      }
    },
    required: []
  }

  description = 'useful when you want to know what is inside a photo, such as user\'s avatar or other pictures'

  func = async function (opts) {
    let { imgUrl, qq, question } = opts
    if (qq) {
      imgUrl = `https://q1.qlogo.cn/g?b=qq&s=160&nk=${qq}`
    }
    if (!imgUrl) {
      return 'you must give at least one parameter of imgUrl and qq'
    }
    const imageResponse = await fetch(imgUrl)
    const blob = await imageResponse.blob()
    const arrayBuffer = await blob.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    // await fs.writeFileSync(`data/chatgpt/${crypto.randomUUID()}`, buffer)
    let formData = new FormData()
    formData.append('file', new File([buffer], 'file.png', { type: 'image/png' }))
    let endpoint = 'image-captioning'
    if (question) {
      endpoint = 'visual-qa?q=' + question
    }
    let captionRes = await fetch(`${Config.extraUrl}/${endpoint}`, {
      method: 'POST',
      body: formData
    })
    if (captionRes.status === 200) {
      let result = await captionRes.text()
      return `${result}`
    } else {
      return 'error happened'
    }
  }
}
