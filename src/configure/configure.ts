const uuid = require('uuid/v4');
import { AppServiceClient } from './clients/azure/appServiceClient';
import { AzureDevOpsClient } from './clients/devOps/azureDevOpsClient';
import { AzureDevOpsHelper } from './helper/devOps/azureDevOpsHelper';
import { AzureTreeItem, UserCancelledError } from 'vscode-azureextensionui';
import { generateDevOpsOrganizationName } from './helper/commonHelper';
import { GenericResource } from 'azure-arm-resource/lib/resource/models';
import { LocalGitRepoHelper } from './helper/LocalGitRepoHelper';
import { Messages } from './resources/messages';
import { SourceOptions, RepositoryProvider, extensionVariables, WizardInputs, WebAppKind, PipelineTemplate, QuickPickItemWithData, GitRepositoryParameters, GitBranchDetails, TargetResourceType } from './model/models';
import { TracePoints } from './resources/tracePoints';
import { TelemetryKeys } from './resources/telemetryKeys';
import * as constants from './resources/constants';
import * as path from 'path';
import * as templateHelper from './helper/templateHelper';
import * as utils from 'util';
import * as vscode from 'vscode';
import { Result, telemetryHelper } from './helper/telemetryHelper';
import { ControlProvider } from './helper/controlProvider';
import { GitHubProvider } from './helper/gitHubHelper';
import { getSubscriptionSession } from './helper/azureSessionHelper';
import { AzureResourceClient } from './clients/azure/azureResourceClient';
import { Configurer } from './configurers/configurerBase';
import { ConfigurerFactory } from './configurers/configurerFactory';

const Layer: string = 'configure';
export const UniqueResourceNameSuffix: string = uuid().substr(0, 5);

export async function configurePipeline(node: AzureTreeItem) {
    await telemetryHelper.executeFunctionWithTimeTelemetry(async () => {
        try {
            if (!(await extensionVariables.azureAccountExtensionApi.waitForLogin())) {
                // set telemetry
                telemetryHelper.setTelemetry(TelemetryKeys.AzureLoginRequired, 'true');

                let signIn = await vscode.window.showInformationMessage(Messages.azureLoginRequired, Messages.signInLabel);
                if (signIn && signIn.toLowerCase() === Messages.signInLabel.toLowerCase()) {
                    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: Messages.waitForAzureSignIn },
                        async () => {
                            await vscode.commands.executeCommand("azure-account.login");
                        });
                }
                else {
                    let error = new Error(Messages.azureLoginRequired);
                    telemetryHelper.setResult(Result.Failed, error);
                    throw error;
                }
            }

            var configurer = new Orchestrator();
            await configurer.configure(node);
        }
        catch (error) {
            if (!(error instanceof UserCancelledError)) {
                extensionVariables.outputChannel.appendLine(error.message);
                vscode.window.showErrorMessage(error.message);
                telemetryHelper.setResult(Result.Failed, error);
            }
            else {
                telemetryHelper.setResult(Result.Canceled, error);
            }
        }
    }, TelemetryKeys.CommandExecutionDuration);
}

export class Orchestrator {
    private inputs: WizardInputs;
    private localGitRepoHelper: LocalGitRepoHelper;
    private azureDevOpsClient: AzureDevOpsClient;
    private appServiceClient: AppServiceClient;
    private workspacePath: string;
    private controlProvider: ControlProvider;
    private pipelineConfigurer: Configurer;

    public constructor() {
        this.inputs = new WizardInputs();
        this.controlProvider = new ControlProvider();
    }

    public async configure(node: any) {
        telemetryHelper.setCurrentStep('GetAllRequiredInputs');
        await this.getAllRequiredInputs(node);

        telemetryHelper.setCurrentStep('CreatePreRequisites');
        await this.pipelineConfigurer.createPreRequisites(this.inputs);
        // await this.createPreRequisites();

        telemetryHelper.setCurrentStep('CheckInPipeline');
        await this.checkInPipelineFileToRepository();

        telemetryHelper.setCurrentStep('CreateAndRunPipeline');
        await this.pipelineConfigurer.createAndQueuePipeline(this.inputs);

        telemetryHelper.setCurrentStep('PostPipelineCreation');
        // This step should be determined by the resoruce target provider (azure app service, function app, aks) type and pipelineProvider(azure pipeline vs github)
        this.pipelineConfigurer.postPipelineCreationSteps(this.inputs, this.appServiceClient);
        // this.updateScmType(queuedPipeline);

        telemetryHelper.setCurrentStep('DisplayCreatedPipeline');
        this.pipelineConfigurer.browseQueuedPipeline();
    }

    private async getAllRequiredInputs(node: any) {
        await this.analyzeNode(node);
        await this.getSourceRepositoryDetails();
        await this.getSelectedPipeline();

        if (!this.inputs.targetResource.resource) {
            await this.getAzureResourceDetails();
        }

        this.pipelineConfigurer = ConfigurerFactory.GetConfigurer(this.inputs.sourceRepository);
        if (this.inputs.sourceRepository.repositoryProvider === RepositoryProvider.AzureRepos) {
            await this.getAzureDevOpsDetails();
        }
    }

    // private async createPreRequisites(): Promise<void> {
        // if (this.inputs.isNewOrganization) {
        //     this.inputs.project = {
        //         id: "",
        //         name: generateDevOpsProjectName(this.inputs.sourceRepository.repositoryName)
        //     };
        //     await vscode.window.withProgress(
        //         {
        //             location: vscode.ProgressLocation.Notification,
        //             title: Messages.creatingAzureDevOpsOrganization
        //         },
        //         () => {
        //             return this.azureDevOpsClient.createOrganization(this.inputs.organizationName)
        //                 .then(() => {
        //                     this.azureDevOpsClient.listOrganizations(true);
        //                     return this.azureDevOpsClient.createProject(this.inputs.organizationName, this.inputs.project.name);
        //                 })
        //                 .then(() => {
        //                     return this.azureDevOpsClient.getProjectIdFromName(this.inputs.organizationName, this.inputs.project.name);
        //                 })
        //                 .then((projectId) => {
        //                     this.inputs.project.id = projectId;
        //                 })
        //                 .catch((error) => {
        //                     telemetryHelper.logError(Layer, TracePoints.CreateNewOrganizationAndProjectFailure, error);
        //                     throw error;
        //                 });
        //         });
        // }

        // if (this.inputs.sourceRepository.repositoryProvider === RepositoryProvider.Github) {
        //     await this.createGithubServiceConnection();
        // }
    // }

    private async analyzeNode(node: any): Promise<void> {
        if (!!node && !!node.fullId) {
            await this.extractAzureResourceFromNode(node);
        }
        else if (node && node.fsPath) {
            this.workspacePath = node.fsPath;
            telemetryHelper.setTelemetry(TelemetryKeys.SourceRepoLocation, SourceOptions.CurrentWorkspace);
        }
    }

    private async getSourceRepositoryDetails(): Promise<void> {
        try {
            if (!this.workspacePath) { // This is to handle when we have already identified the repository details.
                await this.setWorkspace();
            }

            await this.getGitDetailsFromRepository();
        }
        catch (error) {
            telemetryHelper.logError(Layer, TracePoints.GetSourceRepositoryDetailsFailed, error);
            throw error;
        }
    }

    private async setWorkspace(): Promise<void> {
        let workspaceFolders = vscode.workspace && vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            telemetryHelper.setTelemetry(TelemetryKeys.SourceRepoLocation, SourceOptions.CurrentWorkspace);

            if (workspaceFolders.length === 1) {
                telemetryHelper.setTelemetry(TelemetryKeys.MultipleWorkspaceFolders, 'false');
                this.workspacePath = workspaceFolders[0].uri.fsPath;
            }
            else {
                telemetryHelper.setTelemetry(TelemetryKeys.MultipleWorkspaceFolders, 'true');
                let workspaceFolderOptions: Array<QuickPickItemWithData> = [];
                for (let folder of workspaceFolders) {
                    workspaceFolderOptions.push({ label: folder.name, data: folder });
                }
                let selectedWorkspaceFolder = await this.controlProvider.showQuickPick(
                    constants.SelectFromMultipleWorkSpace,
                    workspaceFolderOptions,
                    { placeHolder: Messages.selectWorkspaceFolder });
                this.workspacePath = selectedWorkspaceFolder.data.uri.fsPath;
            }
        }
        else {
            telemetryHelper.setTelemetry(TelemetryKeys.SourceRepoLocation, SourceOptions.BrowseLocalMachine);
            let selectedFolder: vscode.Uri[] = await vscode.window.showOpenDialog(
                {
                    openLabel: Messages.selectFolderLabel,
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                }
            );
            if (selectedFolder && selectedFolder.length > 0) {
                this.workspacePath = selectedFolder[0].fsPath;
            }
            else {
                throw new Error(Messages.noWorkSpaceSelectedError);
            }
        }
    }

    private async getGitDetailsFromRepository(): Promise<void> {
        this.localGitRepoHelper = await LocalGitRepoHelper.GetHelperInstance(this.workspacePath);
        let gitBranchDetails = await this.localGitRepoHelper.getGitBranchDetails();

        if (!gitBranchDetails.remoteName) {
            // Remote tracking branch is not set
            let remotes = await this.localGitRepoHelper.getGitRemotes();
            if (remotes.length === 0) {
                throw new Error(Messages.branchRemoteMissing);
            }
            else if (remotes.length === 1) {
                gitBranchDetails.remoteName = remotes[0].name;
            }
            else {
                // Show an option to user to select remote to be configured
                let selectedRemote = await this.controlProvider.showQuickPick(
                    constants.SelectRemoteForRepo,
                    remotes.map(remote => { return { label: remote.name }; }),
                    { placeHolder: Messages.selectRemoteForBranch });
                gitBranchDetails.remoteName = selectedRemote.label;
            }
        }

        // Set working directory relative to repository root
        let gitRootDir = await this.localGitRepoHelper.getGitRootDirectory();
        this.inputs.pipelineParameters.workingDirectory = path.relative(gitRootDir, this.workspacePath);

        this.inputs.sourceRepository = await this.getGitRepositoryParameters(gitBranchDetails);

        // set telemetry
        telemetryHelper.setTelemetry(TelemetryKeys.RepoProvider, this.inputs.sourceRepository.repositoryProvider);
    }

    private async getGitRepositoryParameters(gitRepositoryDetails: GitBranchDetails): Promise<GitRepositoryParameters> {
        let remoteUrl = await this.localGitRepoHelper.getGitRemoteUrl(gitRepositoryDetails.remoteName);

        if (remoteUrl) {
            if (AzureDevOpsHelper.isAzureReposUrl(remoteUrl)) {
                return <GitRepositoryParameters>{
                    repositoryProvider: RepositoryProvider.AzureRepos,
                    repositoryId: "",
                    repositoryName: AzureDevOpsHelper.getRepositoryDetailsFromRemoteUrl(remoteUrl).repositoryName,
                    remoteName: gitRepositoryDetails.remoteName,
                    remoteUrl: remoteUrl,
                    branch: gitRepositoryDetails.branch,
                    commitId: "",
                    localPath: this.workspacePath
                };
            }
            else if (GitHubProvider.isGitHubUrl(remoteUrl)) {
                let repoId = GitHubProvider.getRepositoryIdFromUrl(remoteUrl);
                return <GitRepositoryParameters>{
                    repositoryProvider: RepositoryProvider.Github,
                    repositoryId: repoId,
                    repositoryName: repoId,
                    remoteName: gitRepositoryDetails.remoteName,
                    remoteUrl: remoteUrl,
                    branch: gitRepositoryDetails.branch,
                    commitId: "",
                    localPath: this.workspacePath
                };
            }
            else {
                throw new Error(Messages.cannotIdentifyRespositoryDetails);
            }
        }
        else {
            throw new Error(Messages.remoteRepositoryNotConfigured);
        }
    }

    // private async getGitHubPATToken(): Promise<string> {
    //     let githubPat = null;
    //     await telemetryHelper.executeFunctionWithTimeTelemetry(
    //         async () => {
    //             githubPat = await this.controlProvider.showInputBox(
    //                 constants.GitHubPat,
    //                 {
    //                     placeHolder: Messages.enterGitHubPat,
    //                     prompt: Messages.githubPatTokenHelpMessage,
    //                     validateInput: (inputValue) => {
    //                         return !inputValue ? Messages.githubPatTokenErrorMessage : null;
    //                     }
    //                 });
    //         },
    //         TelemetryKeys.GitHubPatDuration);
    //     return githubPat;
    // }

    private async extractAzureResourceFromNode(node: any): Promise<void> {
        this.inputs.targetResource.subscriptionId = node.root.subscriptionId;
        this.inputs.azureSession = getSubscriptionSession(this.inputs.targetResource.subscriptionId);
        this.appServiceClient = new AppServiceClient(this.inputs.azureSession.credentials, this.inputs.azureSession.tenantId, this.inputs.azureSession.environment.portalUrl, this.inputs.targetResource.subscriptionId);

        try {
            let azureResource: GenericResource = await this.appServiceClient.getAppServiceResource((<AzureTreeItem>node).fullId);
            AzureResourceClient.validateTargetResourceType(azureResource);
            this.inputs.targetResource.resource = azureResource;
        }
        catch (error) {
            telemetryHelper.logError(Layer, TracePoints.ExtractAzureResourceFromNodeFailed, error);
            throw error;
        }
    }

    private async getAzureDevOpsDetails(): Promise<void> {
        try {
            this.createAzureDevOpsClient();
            if (this.inputs.sourceRepository.repositoryProvider === RepositoryProvider.AzureRepos) {
                let repoDetails = AzureDevOpsHelper.getRepositoryDetailsFromRemoteUrl(this.inputs.sourceRepository.remoteUrl);
                this.inputs.organizationName = repoDetails.orgnizationName;
                await this.azureDevOpsClient.getRepository(this.inputs.organizationName, repoDetails.projectName, this.inputs.sourceRepository.repositoryName)
                    .then((repository) => {
                        this.inputs.sourceRepository.repositoryId = repository.id;
                        this.inputs.project = {
                            id: repository.project.id,
                            name: repository.project.name
                        };
                    });
            }
            else {
                this.inputs.isNewOrganization = false;
                let devOpsOrganizations = await this.azureDevOpsClient.listOrganizations();

                if (devOpsOrganizations && devOpsOrganizations.length > 0) {
                    let selectedOrganization = await this.controlProvider.showQuickPick(
                        constants.SelectOrganization,
                        devOpsOrganizations.map(x => { return { label: x.accountName }; }),
                        { placeHolder: Messages.selectOrganization },
                        TelemetryKeys.OrganizationListCount);
                    this.inputs.organizationName = selectedOrganization.label;

                    let selectedProject = await this.controlProvider.showQuickPick(
                        constants.SelectProject,
                        this.azureDevOpsClient.listProjects(this.inputs.organizationName)
                            .then((projects) => projects.map(x => { return { label: x.name, data: x }; })),
                        { placeHolder: Messages.selectProject },
                        TelemetryKeys.ProjectListCount);
                    this.inputs.project = selectedProject.data;
                }
                else {
                    telemetryHelper.setTelemetry(TelemetryKeys.NewOrganization, 'true');

                    this.inputs.isNewOrganization = true;
                    let userName = this.inputs.azureSession.userId.substring(0, this.inputs.azureSession.userId.indexOf("@"));
                    let organizationName = generateDevOpsOrganizationName(userName, this.inputs.sourceRepository.repositoryName);

                    let validationErrorMessage = await this.azureDevOpsClient.validateOrganizationName(organizationName);
                    if (validationErrorMessage) {
                        this.inputs.organizationName = await this.controlProvider.showInputBox(
                            constants.EnterOrganizationName,
                            {
                                placeHolder: Messages.enterAzureDevOpsOrganizationName,
                                validateInput: (organizationName) => this.azureDevOpsClient.validateOrganizationName(organizationName)
                            });
                    }
                    else {
                        this.inputs.organizationName = organizationName;
                    }
                }
            }
        }
        catch (error) {
            telemetryHelper.logError(Layer, TracePoints.GetAzureDevOpsDetailsFailed, error);
            throw error;
        }
    }

    private async getSelectedPipeline(): Promise<void> {
        let appropriatePipelines: PipelineTemplate[] = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: Messages.analyzingRepo },
            () => templateHelper.analyzeRepoAndListAppropriatePipeline(
                this.inputs.sourceRepository.localPath,
                this.inputs.sourceRepository.repositoryProvider,
                this.inputs.targetResource.resource)
        );

        // TO:DO- Get applicable pipelines for the repo type and azure target type if target already selected
        let selectedOption = await this.controlProvider.showQuickPick(
            constants.SelectPipelineTemplate,
            appropriatePipelines.map((pipeline) => { return { label: pipeline.label }; }),
            { placeHolder: Messages.selectPipelineTemplate },
            TelemetryKeys.PipelineTempateListCount);
        this.inputs.pipelineParameters.pipelineTemplate = appropriatePipelines.find((pipeline) => {
            return pipeline.label === selectedOption.label;
        });
        telemetryHelper.setTelemetry(TelemetryKeys.ChosenTemplate, this.inputs.pipelineParameters.pipelineTemplate.label);
    }

    private async getAzureResourceDetails(): Promise<void> {
        // show available subscriptions and get the chosen one
        let subscriptionList = extensionVariables.azureAccountExtensionApi.filters.map((subscriptionObject) => {
            return <QuickPickItemWithData>{
                label: `${<string>subscriptionObject.subscription.displayName}`,
                data: subscriptionObject,
                description: `${<string>subscriptionObject.subscription.subscriptionId}`
            };
        });
        let selectedSubscription: QuickPickItemWithData = await this.controlProvider.showQuickPick(constants.SelectSubscription, subscriptionList, { placeHolder: Messages.selectSubscription });
        this.inputs.targetResource.subscriptionId = selectedSubscription.data.subscription.subscriptionId;
        this.inputs.azureSession = getSubscriptionSession(this.inputs.targetResource.subscriptionId);

        // show available resources and get the chosen one
        switch(this.inputs.pipelineParameters.pipelineTemplate.targetType) {
            case TargetResourceType.None:
                break;
            case TargetResourceType.WebApp:
            default:
                this.appServiceClient = new AppServiceClient(this.inputs.azureSession.credentials, this.inputs.azureSession.tenantId, this.inputs.azureSession.environment.portalUrl, this.inputs.targetResource.subscriptionId);
                let selectedResource: QuickPickItemWithData = await this.controlProvider.showQuickPick(
                    constants.SelectWebApp,
                    this.appServiceClient.GetAppServices(this.inputs.pipelineParameters.pipelineTemplate.targetKind ? this.inputs.pipelineParameters.pipelineTemplate.targetKind : WebAppKind.WindowsApp)
                        .then((webApps) => webApps.map(x => { return { label: x.name, data: x }; })),
                    { placeHolder: Messages.selectWebApp },
                    TelemetryKeys.WebAppListCount);
                this.inputs.targetResource.resource = selectedResource.data;
        }
    }

    // private async updateScmType(queuedPipeline: Build): Promise<void> {
    //     try {
    //         // update SCM type
    //         let updateScmPromise = this.appServiceClient.updateScmType(this.inputs.targetResource.resource.id);

    //         let buildDefinitionUrl = this.azureDevOpsClient.getOldFormatBuildDefinitionUrl(this.inputs.organizationName, this.inputs.project.id, queuedPipeline.definition.id);
    //         let buildUrl = this.azureDevOpsClient.getOldFormatBuildUrl(this.inputs.organizationName, this.inputs.project.id, queuedPipeline.id);

    //         // update metadata of app service to store information about the pipeline deploying to web app.
    //         let updateMetadataPromise = new Promise<void>(async (resolve) => {
    //             let metadata = await this.appServiceClient.getAppServiceMetadata(this.inputs.targetResource.resource.id);
    //             metadata["properties"] = metadata["properties"] ? metadata["properties"] : {};
    //             metadata["properties"]["VSTSRM_ProjectId"] = `${this.inputs.project.id}`;
    //             metadata["properties"]["VSTSRM_AccountId"] = await this.azureDevOpsClient.getOrganizationIdFromName(this.inputs.organizationName);
    //             metadata["properties"]["VSTSRM_BuildDefinitionId"] = `${queuedPipeline.definition.id}`;
    //             metadata["properties"]["VSTSRM_BuildDefinitionWebAccessUrl"] = `${buildDefinitionUrl}`;
    //             metadata["properties"]["VSTSRM_ConfiguredCDEndPoint"] = '';
    //             metadata["properties"]["VSTSRM_ReleaseDefinitionId"] = '';

    //             this.appServiceClient.updateAppServiceMetadata(this.inputs.targetResource.resource.id, metadata);
    //             resolve();
    //         });

    //         // send a deployment log with information about the setup pipeline and links.
    //         let updateDeploymentLogPromise = this.appServiceClient.publishDeploymentToAppService(
    //             this.inputs.targetResource.resource.id,
    //             buildDefinitionUrl,
    //             buildDefinitionUrl,
    //             buildUrl);

    //             Q.all([updateScmPromise, updateMetadataPromise, updateDeploymentLogPromise])
    //             .then(() => {
    //                 telemetryHelper.setTelemetry(TelemetryKeys.UpdatedWebAppMetadata, 'true');
    //             })
    //             .catch((error) => {
    //                 telemetryHelper.setTelemetry(TelemetryKeys.UpdatedWebAppMetadata, 'false');
    //                 throw error;
    //             });
    //     }
    //     catch (error) {
    //         telemetryHelper.logError(Layer, TracePoints.PostDeploymentActionFailed, error);
    //     }
    // }

    // private async createGithubServiceConnection(): Promise<void> {
    //     if (!this.serviceConnectionHelper) {
    //         this.serviceConnectionHelper = new ServiceConnectionHelper(this.inputs.organizationName, this.inputs.project.name, this.azureDevOpsClient);
    //     }

    //     // Create GitHub service connection in Azure DevOps
    //     await vscode.window.withProgress(
    //         {
    //             location: vscode.ProgressLocation.Notification,
    //             title: Messages.creatingGitHubServiceConnection
    //         },
    //         async () => {
    //             try {
    //                 let serviceConnectionName = `${this.inputs.sourceRepository.repositoryName}-${UniqueResourceNameSuffix}`;
    //                 this.inputs.sourceRepository.serviceConnectionId = await this.serviceConnectionHelper.createGitHubServiceConnection(serviceConnectionName, this.inputs.githubPATToken);
    //             }
    //             catch (error) {
    //                 telemetryHelper.logError(Layer, TracePoints.GitHubServiceConnectionError, error);
    //                 throw error;
    //             }
    //         });
    // }

    private async checkInPipelineFileToRepository(): Promise<void> {
        try {
            let pipelineFilePath = this.pipelineConfigurer.getPipelineFileName(this.inputs);
            this.inputs.pipelineParameters.pipelineFileName = await this.localGitRepoHelper.addContentToFile(
                await templateHelper.renderContent(this.inputs.pipelineParameters.pipelineTemplate.path, this.inputs),
                pipelineFilePath);
            await vscode.window.showTextDocument(vscode.Uri.file(path.join(this.inputs.sourceRepository.localPath, this.inputs.pipelineParameters.pipelineFileName)));
        }
        catch (error) {
            telemetryHelper.logError(Layer, TracePoints.AddingContentToPipelineFileFailed, error);
            throw error;
        }

        try {
            while (!this.inputs.sourceRepository.commitId) {
                let commitOrDiscard = await vscode.window.showInformationMessage(utils.format(Messages.modifyAndCommitFile, Messages.commitAndPush, this.inputs.sourceRepository.branch, this.inputs.sourceRepository.remoteName), Messages.commitAndPush, Messages.discardPipeline);
                if (commitOrDiscard && commitOrDiscard.toLowerCase() === Messages.commitAndPush.toLowerCase()) {
                    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: Messages.configuringPipelineAndDeployment }, async (progress) => {
                        try {
                            // handle when the branch is not upto date with remote branch and push fails
                            this.inputs.sourceRepository.commitId = await this.localGitRepoHelper.commitAndPushPipelineFile(this.inputs.pipelineParameters.pipelineFileName, this.inputs.sourceRepository);
                        }
                        catch (error) {
                            telemetryHelper.logError(Layer, TracePoints.CheckInPipelineFailure, error);
                            vscode.window.showErrorMessage(utils.format(Messages.commitFailedErrorMessage, error.message));
                        }
                    });
                }
                else {
                    telemetryHelper.setTelemetry(TelemetryKeys.PipelineDiscarded, 'true');
                    throw new UserCancelledError(Messages.operationCancelled);
                }
            }
        }
        catch (error) {
            telemetryHelper.logError(Layer, TracePoints.PipelineFileCheckInFailed, error);
            throw error;
        }
    }

    private createAzureDevOpsClient(): void {
        this.azureDevOpsClient = new AzureDevOpsClient(this.inputs.azureSession.credentials);
    }
}

// this method is called when your extension is deactivated
export function deactivate() { }
