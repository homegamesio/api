const { verifyToken } = require('./crypto');
const { getUserRecord } = require('./db');

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
const adminUsersRegex = '/admin/users';
const adminGamesRegex = '/admin/games';
const adminAssetsRegex = '/admin/assets';
const adminStatsRegex = '/admin/stats';
const adminAssetNsfwRegex = '/admin/assets/(\\S*)/nsfw';
const assetsListRegex = '/assets';
const publicAssetsCatalogRegex = '/catalog/assets';
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
const refreshRegex = '/auth/refresh';
const verifyEmailRegex = '/auth/verify';
const resendVerificationRegex = '/auth/resend';
const meRegex = '/auth/me';
const forgotPasswordRegex = '/auth/forgot';
const resetPasswordRegex = '/auth/reset';
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

const createSessionRegex = '/sessions';
const publishedVersionsRegex = '/games/(\\S*)/published-versions';
const gameSourceTreeRegex = '/games/(\\S*)/source-tree';
const gameSourceFileRegex = '/games/(\\S*)/source';
const gameLocalManifestRegex = '/games/(\\S*)/local-manifest';
const gameLocalAssetBundleRegex = '/games/(\\S*)/asset-bundle';
const gameLocalDownloadRegex = '/games/(\\S*)/download';
const gamePlayCountRegex = '/games/(\\S*)/play';
const assetTagsRegex = '/assets/(\\S*)/tags';
const assetMetaRegex = '/assets/(\\S*)/meta';

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
const studioGetTemplateFilesRegex = '/studio/templates/(\\w+)/files';
const studioPublishRegex = '/studio/games/(\\S*)/publish';
const studioPublishStatusRegex = '/studio/games/(\\S*)/publish-status';
const studioSetThumbnailRegex = '/studio/games/(\\S*)/thumbnail';
const studioLLMModifyRegex = '/studio/games/(\\S*)/llm-modify';
const studioLLMStatusRegex = '/studio/games/(\\S*)/llm-status';
const llmResultRegex = '/internal/llm-result';
const webhookPushRegex = '/webhook/push';
const toggleFeaturedRegex = '/admin/games/(\\S*)/feature';
const deleteDeveloperRegex = '/admin/developers/(\\S*)';

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
                        res.writeHead(401);
                        res.end('API requires authorization');
                    } else {
                        verifyToken(authHeader).then((userInfo) => {
                            if (handlerInfo.requiresVerified) {
                                // Gate code-execution / upload actions on a
                                // verified email address.
                                getUserRecord(userInfo.userId).then((user) => {
                                    if (!user || !user.verified) {
                                        res.writeHead(403, { 'Content-Type': 'application/json' });
                                        res.end(JSON.stringify({ error: 'Email verification required' }));
                                    } else {
                                        handlerInfo.handle(req, res, userInfo.userId, ...matchedParams);
                                    }
                                }).catch(err => {
                                    console.error(err);
                                    res.writeHead(500);
                                    res.end('error');
                                });
                            } else {
                                handlerInfo.handle(req, res, userInfo.userId, ...matchedParams);
                            }
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
        [deleteDeveloperRegex]: { requiresAuth: true, handle: h.handleDeleteDeveloper },
        [gameDetailRegex]: { requiresAuth: true, handle: h.handleDeleteGame },
        [assetsRegex]: { requiresAuth: true, handle: h.handleDeleteAsset },
    },
    'POST': {
        [mapRegex]: { handle: h.handlePostMap },
        [profileRegex]: { requiresAuth: true, handle: h.handlePostProfile },
        [verifyDnsRegex]: { handle: h.handleVerifyDns },
        [adminAckRegex]: { requiresAuth: true, handle: h.handleAdminAck },
        [certRequestRegex]: { handle: h.handlePostCertRequest },
        [bugsRegex]: { handle: h.handleBugs },
        [contactRegex]: { handle: h.handleContact },
        [createGameRegex]: { requiresAuth: true, requiresVerified: true, handle: h.handleCreateGame },
        [assetTagsRegex]: { requiresAuth: true, handle: h.handleUpdateAssetTags },
        [assetMetaRegex]: { requiresAuth: true, handle: h.handleUpdateAssetMeta },
        [createAssetRegex]: { requiresAuth: true, requiresVerified: true, handle: h.handleCreateAsset },
        [gamePublishRegex]: { requiresAuth: true, requiresVerified: true, handle: h.handleGamePublish },
        [gameUpdateRegex]: { requiresAuth: true, requiresVerified: true, handle: h.handleGameUpdate },
        [servicesRegex]: { handle: h.handleServices },
        [submitPublishRequestRegex]: { requiresAuth: true, requiresVerified: true, handle: h.handleSubmitPublishRequest },
        [createBlogRegex]: { requiresAuth: true, handle: h.handleCreateBlog },
        [signupRegex]: { handle: h.handleSignup },
        [loginRegex]: { handle: h.handleLogin },
        [forgotPasswordRegex]: { handle: h.handleForgotPassword },
        [resetPasswordRegex]: { handle: h.handleResetPassword },
        [refreshRegex]: { requiresAuth: true, handle: h.handleRefreshToken },
        [verifyEmailRegex]: { requiresAuth: true, handle: h.handleVerifyCode },
        [resendVerificationRegex]: { requiresAuth: true, handle: h.handleResendVerification },
        [requestActionRegex]: { requiresAuth: true, handle: h.handleRequestAction },
        [studioCreateGameRegex]: { requiresAuth: true, requiresVerified: true, handle: s.handleStudioCreateGame },
        [studioSaveVersionRegex]: { requiresAuth: true, requiresVerified: true, handle: s.handleSaveVersion },
        [studioRestoreVersionRegex]: { requiresAuth: true, requiresVerified: true, handle: s.handleRestoreVersion },
        [studioSetThumbnailRegex]: { requiresAuth: true, requiresVerified: true, handle: s.handleSetGameThumbnail },
        [studioPublishRegex]: { requiresAuth: true, requiresVerified: true, handle: s.handleSubmitPublishRequest },
        [studioLLMModifyRegex]: { requiresAuth: true, requiresVerified: true, handle: s.handleSubmitLLMRequest },
        [llmResultRegex]: { handle: s.handleLLMResult },
        [createSessionRegex]: { handle: h.handleCreateSession },
        [gamePlayCountRegex]: { handle: h.handleCountPlay },
        [webhookPushRegex]: { handle: s.handleWebhookPush },
        [toggleFeaturedRegex]: { requiresAuth: true, handle: s.handleToggleFeatured },
        [adminAssetNsfwRegex]: { requiresAuth: true, handle: h.handleAdminSetAssetNsfw },
    },
    'GET': {
        [meRegex]: { requiresAuth: true, handle: h.handleMe },
        [adminUsersRegex]: { requiresAuth: true, handle: h.handleAdminListUsers },
        [adminGamesRegex]: { requiresAuth: true, handle: h.handleAdminListGames },
        [adminAssetsRegex]: { requiresAuth: true, handle: h.handleAdminListAssets },
        [adminStatsRegex]: { requiresAuth: true, handle: h.handleAdminStats },
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
        [gameSourceTreeRegex]: { handle: h.handleGetGameSourceTree },
        [gameSourceFileRegex]: { handle: h.handleGetGameSourceFile },
        [gameLocalManifestRegex]: { handle: h.handleGetLocalManifest },
        [gameLocalAssetBundleRegex]: { handle: h.handleGetLocalAssetBundle },
        [gameLocalDownloadRegex]: { handle: h.handleGetLocalDownload },
        [publishedVersionsRegex]: { handle: h.handleGetPublishedVersions },
        [gameDetailRegex]: { handle: h.handleGetGameDetail },
        [ipRegex]: { handle: h.handleGetIp },
        [gameVersionDetailRegex]: { handle: h.handleGetGameVersionDetail },
        [publicAssetsCatalogRegex]: { handle: h.handleListPublicAssets },
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
        [studioPublishStatusRegex]: { requiresAuth: true, handle: s.handleGetPublishStatuses },
        [studioLLMStatusRegex]: { requiresAuth: true, handle: s.handleGetLLMStatus },
        [studioGetCloneInfoRegex]: { requiresAuth: true, handle: s.handleGetCloneInfo },
        [studioGetVersionsRegex]: { requiresAuth: true, handle: s.handleGetVersions },
        [studioGetTemplatesRegex]: { handle: s.handleGetTemplates },
        [studioGetTemplateFilesRegex]: { handle: s.handleGetTemplateFiles },
        [studioGetBuildsRegex]: { requiresAuth: true, handle: s.handleGetBuilds },
        [studioListGamesRegex]: { requiresAuth: true, handle: s.handleStudioListGames },
    }
});

module.exports = {
    dispatchRequest,
    buildRequestHandlers,
};
