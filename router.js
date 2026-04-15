const { verifyToken } = require('./crypto');

// Route regex patterns
const publishRequestsRegex = '/games/(\\S*)/publish_requests';
const profileRegex = '/profile';
const devProfileRegex = '/profile/(\\S*)';
const publishRequestEventsRegex = '/publish_requests/(\\S*)/events';
const gameDetailRegex = '/games/(\\S*)';
const gameVersionDetailRegex = '/games/(\\S*)/version/(\\S*)';
const healthRegex = '/health';
const adminListSupportMessagesRegex = '/admin/support_messages';
const adminAckRegex = '/admin/acknowledge';
const adminListPendingPublishRequestsRegex = '/admin/publish_requests';
const adminListFailedPublishRequestsRegex = '/admin/publish_requests/failed';
const assetsListRegex = '/assets';
const verifyPublishRequestRegex = '/verify_publish_request';
const listGamesRegex = '/games';
const listMyGamesRegex = '/my-games';
const podcastRegex = '/podcast';
const linkRegex = '/link';
const ipRegex = '/ip';
const servicesRegex = '/services';
const serviceRequestsRegex = '/service_requests/(\\S*)';
const loginRegex = '/auth/login';
const signupRegex = '/auth/signup';
const createBlogRegex = '/admin/blog';
const blogRegex = '/blog';
const blogDetailRegex = '/blog/(\\S*)';
const githubLinkRegex = '/github_link';
const mapRegex = '/map';

// terrible names
const submitPublishRequestRegex = '/public_publish';
const gamePublishRegex = '/games/(\\S*)/publish';
const gameUpdateRegex = '/games/(\\S*)/update';
const requestActionRegex = '/admin/request/(\\S*)/action';
const createAssetRegex = '/asset';
const createGameRegex = '/games';
const bugsRegex = '/bugs';
const contactRegex = '/contact';

const verifyDnsRegex = '/verifyDns';
const certRequestRegex = '/request-cert';
const certStatusRegex = '/cert-status';
const assetsRegex = '/assets/(\\S*)';

// Studio routes
const studioCreateGameRegex = '/studio/games';
const studioListGamesRegex = '/studio/games';
const studioGetFilesRegex = '/studio/games/(\\S*)/files';
const studioGetFileContentRegex = '/studio/games/(\\S*)/file';
const studioSaveVersionRegex = '/studio/games/(\\S*)/save';
const studioGetVersionsRegex = '/studio/games/(\\S*)/versions';
const studioGetVersionFilesRegex = '/studio/games/(\\S*)/versions/(\\S*)/files';
const studioRestoreVersionRegex = '/studio/games/(\\S*)/restore';
const studioGetCloneInfoRegex = '/studio/games/(\\S*)/clone';
const studioGetBuildsRegex = '/studio/games/(\\S*)/builds';
const studioGetTemplatesRegex = '/studio/templates';
const webhookPushRegex = '/webhook/push';
const toggleFeaturedRegex = '/admin/games/(\\S*)/feature';

const dispatchRequest = (req, res, requestHandlers) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
    } else if (!requestHandlers[req.method]) {
        res.writeHead(400);
        res.end('Unsupported method: ' + req.method);
    } else {
        // sort with largest values upfront to get the most specific match
        const matchers = Object.keys(requestHandlers[req.method]).sort((a, b) => b.length - a.length);
        let matched = null;
        for (let i = 0; i < matchers.length; i++) {
            matched = req.url.match(new RegExp(matchers[i]));
            if (matched) {
                const matchedParams = [];
                for (let j = 1; j < matched.length; j++) {
                    matchedParams.push(matched[j]);
                }
                const handlerInfo = requestHandlers[req.method][matchers[i]];
                console.log('wat');
                console.log(handlerInfo);

                if (handlerInfo.requiresAuth) {
                    const authHeader = req.headers.authorization;

                    if (!authHeader) {
                        res.end('API requires authorization');
                    } else {
                        console.log('hmmm');
                        verifyToken(authHeader).then((userInfo) => {
                            handlerInfo.handle(req, res, userInfo.userId, ...matchedParams);
                        }).catch(err => {
                            console.error(err);
                            res.writeHead(401);
                            res.end(err);
                        });
                    }
                } else {
                    handlerInfo.handle(req, res, ...matchedParams);
                }
                break;
            }
        }
        if (!matched) {
            res.writeHead(404);
            res.end('not found');
        }
    }
};

const buildRequestHandlers = (h, s) => ({
    'DELETE': {
        [gameDetailRegex]: { requiresAuth: true, handle: h.handleDeleteGame }
    },
    'POST': {
        [mapRegex]: { handle: h.handlePostMap },
        [profileRegex]: { requiresAuth: true, handle: h.handlePostProfile },
        [verifyDnsRegex]: { handle: h.handleVerifyDns },
        [adminAckRegex]: { requiresAuth: true, handle: h.handleAdminAck },
        [certRequestRegex]: { handle: h.handlePostCertRequest },
        [bugsRegex]: { handle: h.handleBugs },
        [contactRegex]: { handle: h.handleContact },
        [createGameRegex]: { requiresAuth: true, handle: h.handleCreateGame },
        [createAssetRegex]: { requiresAuth: true, handle: h.handleCreateAsset },
        [gamePublishRegex]: { requiresAuth: true, handle: h.handleGamePublish },
        [gameUpdateRegex]: { requiresAuth: true, handle: h.handleGameUpdate },
        [servicesRegex]: { handle: h.handleServices },
        [submitPublishRequestRegex]: { requiresAuth: true, handle: h.handleSubmitPublishRequest },
        [createBlogRegex]: { requiresAuth: true, handle: h.handleCreateBlog },
        [signupRegex]: { handle: h.handleSignup },
        [loginRegex]: { handle: h.handleLogin },
        [requestActionRegex]: { requiresAuth: true, handle: h.handleRequestAction },
        [studioCreateGameRegex]: { requiresAuth: true, handle: s.handleStudioCreateGame },
        [studioSaveVersionRegex]: { requiresAuth: true, handle: s.handleSaveVersion },
        [studioRestoreVersionRegex]: { requiresAuth: true, handle: s.handleRestoreVersion },
        [webhookPushRegex]: { handle: s.handleWebhookPush },
        [toggleFeaturedRegex]: { requiresAuth: true, handle: s.handleToggleFeatured },
    },
    'GET': {
        [mapRegex]: { handle: h.handleGetMap },
        [certStatusRegex]: { handle: h.handleGetCertStatus },
        [assetsRegex]: { handle: h.handleGetAsset },
        [blogRegex]: { handle: h.handleGetBlog },
        [blogDetailRegex]: { handle: h.handleGetBlogDetail },
        [githubLinkRegex]: { requiresAuth: true, handle: h.handleGithubLink },
        [podcastRegex]: { handle: h.handleGetPodcast },
        [serviceRequestsRegex]: { handle: h.handleGetServiceRequest },
        [listMyGamesRegex]: { requiresAuth: true, handle: h.handleListMyGames },
        [listGamesRegex]: { handle: h.handleListGames },
        [gameDetailRegex]: { handle: h.handleGetGameDetail },
        [ipRegex]: { handle: h.handleGetIp },
        [gameVersionDetailRegex]: { handle: h.handleGetGameVersionDetail },
        [assetsListRegex]: { requiresAuth: true, handle: h.handleListAssets },
        [devProfileRegex]: { handle: h.handleGetDevProfile },
        [profileRegex]: { requiresAuth: true, handle: h.handleGetProfile },
        [publishRequestsRegex]: { requiresAuth: true, handle: h.handleGetPublishRequests },
        [adminListSupportMessagesRegex]: { requiresAuth: true, handle: h.handleAdminListSupportMessages },
        [adminListPendingPublishRequestsRegex]: { requiresAuth: true, handle: h.handleAdminListPendingPublishRequests },
        [adminListFailedPublishRequestsRegex]: { requiresAuth: true, handle: h.handleAdminListFailedPublishRequests },
        [healthRegex]: { handle: h.handleHealth },
        [studioGetVersionFilesRegex]: { requiresAuth: true, handle: s.handleGetVersionFiles },
        [studioGetFilesRegex]: { requiresAuth: true, handle: s.handleGetFiles },
        [studioGetFileContentRegex]: { requiresAuth: true, handle: s.handleGetFileContent },
        [studioGetCloneInfoRegex]: { requiresAuth: true, handle: s.handleGetCloneInfo },
        [studioGetVersionsRegex]: { requiresAuth: true, handle: s.handleGetVersions },
        [studioGetTemplatesRegex]: { handle: s.handleGetTemplates },
        [studioGetBuildsRegex]: { requiresAuth: true, handle: s.handleGetBuilds },
        [studioListGamesRegex]: { requiresAuth: true, handle: s.handleStudioListGames },
    }
});

module.exports = {
    dispatchRequest,
    buildRequestHandlers,
};
