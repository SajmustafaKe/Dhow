export async function POST(
    _request: Request,
    { params: _params }: { params: Promise<{ callSid: string }> }
) {
    return new Response('Not implemented', { status: 501 });
    /*
    const { callSid } = await params;
    let logger = new PrefixLogger(`turn:${callSid}`);
    logger.log("Received turn");

    // parse and validate form data
    const formData = await request.formData();
    logger.log('request body:', JSON.stringify(Object.fromEntries(formData)));
    const data = ZRequestData.parse(Object.fromEntries(formData));

    // get call state from db
    // if not found, hangup the call
    const call = await twilioInboundCallsCollection.findOne({
        callSid,
    });
    if (!call) {
        logger.log('Call not found');
        return hangup();
    }
    const { projectId } = call;

    // fetch project and extract live workflow
    const project = await projectsCollection.findOne({
        _id: projectId,
    });
    if (!project) {
        logger.log(`Project ${projectId} not found`);
        return hangup();
    }
    const workflow = project.liveWorkflow;
    if (!workflow) {
        logger.log(`Workflow not found for project ${projectId}`);
        return hangup();
    }

    // add user speech as user message, and get assistant response
    const reqMessages: z.infer<typeof Message>[] = [
        ...call.messages,
        {
            role: 'user',
            content: data.SpeechResult,
        }
    ];
    const { messages } = await getResponse(projectId, workflow, reqMessages);
    if (messages.length === 0) {
        logger.log('Agent response is empty');
        return hangup();
    }
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== 'assistant' || !lastMessage.content) {
        logger.log('Invalid last message');
        return hangup();
    }

    // save call state
    await twilioInboundCallsCollection.updateOne({
        _id: call._id,
    }, {
        $set: {
            messages: [
                ...reqMessages,
                ...messages,
            ],
            lastUpdatedAt: new Date().toISOString(),
        }
    });

    // speak out response
    const response = new VoiceResponse();
    response.say(lastMessage.content);
    response.gather({
        input: ['speech'],
        speechTimeout: 'auto',
        language: 'en-US',
        enhanced: true,
        speechModel: 'phone_call',
        action: `/api/twilio/turn/${callSid}`,
    });
    return XmlResponse(response);
    */
}